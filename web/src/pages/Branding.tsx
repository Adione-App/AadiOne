/**
 * Settings → Branding & Identity — every Aadione brand asset in one place
 * (lib/branding.ts; server: content/branding.service.ts).
 *
 *   Upload / Replace  → checked in the browser for a quick answer, then by the
 *                       server from the file itself (format, size, dimensions,
 *                       shape, transparency); stored optimised; goes into the DRAFT.
 *   Preview           → each asset on light and dark backgrounds, and every
 *                       surface (Admin / Seller Panel header, customer app,
 *                       website header and footer, browser tab) with the draft
 *                       or the published branding.
 *   Publish           → all changes, or only the ones ticked. Live assets reach
 *                       the panels and website within about a minute and the
 *                       customer app on its next refresh.
 *   Default / history → put the built-in artwork or an earlier file back in the
 *                       draft; restore a whole earlier version.
 *
 * App ICONS are part of the installed app: publishing one only makes it the
 * source for the next Android / iOS release (docs/branding-native-assets.md).
 * Phones keep the current icon until that release is installed.
 *
 * Reading needs Configuration access; every change needs Configuration write
 * access (Admin / Super Admin) — the server enforces both.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BRAND_ASSET_GROUP_LABELS,
  BRAND_ASSET_MAX_BYTES,
  BRAND_ASSET_SPECS,
  Permission,
  brandAssetProblems,
  roleHasPermission,
  type AdminBrandSlotDto,
  type AdminBrandingDto,
  type BrandAsset,
  type BrandAssetGroup,
  type BrandAssetSlot,
} from '@shared';
import { Button, Card, ErrorBanner, Modal, Panel, Pill, Spinner } from '@/components/ui';
import { AadioneWordmark } from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { readImageSize, useAdminBranding, useBrandingActions } from '@/lib/branding';

const errorText = (error: unknown): string | null => (error instanceof Error ? error.message : error ? 'Something went wrong.' : null);
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const GROUP_ORDER: BrandAssetGroup[] = ['brand', 'web', 'customer_app', 'seller', 'native'];

/** A checkerboard, so transparent areas are visible. */
const CHECKER =
  'bg-[length:16px_16px] bg-[linear-gradient(45deg,#eef2ef_25%,transparent_25%),linear-gradient(-45deg,#eef2ef_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eef2ef_75%),linear-gradient(-45deg,transparent_75%,#eef2ef_75%)] bg-[position:0_0,0_8px,8px_-8px,-8px_0]';

export default function BrandingPage() {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);
  const branding = useAdminBranding();
  const actions = useBrandingActions();
  const [chosen, setChosen] = useState<Set<BrandAssetSlot>>(() => new Set());
  const [confirm, setConfirm] = useState<null | { publish: BrandAssetSlot[] | 'all' } | 'discard' | { restore: string; revision: number }>(null);
  const [showDraft, setShowDraft] = useState(true);

  if (branding.isLoading) return <Spinner label="Loading branding…" />;
  if (branding.isError || !branding.data) return <ErrorBanner message={errorText(branding.error) ?? 'Could not load the branding.'} />;
  const data = branding.data;

  const changed = data.draft?.changed ?? [];
  const busy = Object.values(actions).some((action) => action.isPending);
  const actionError = errorText(
    actions.upload.error ?? actions.reset.error ?? actions.reuse.error ?? actions.restore.error ?? actions.discard.error ?? actions.publish.error,
  );
  const selected = changed.filter((slot) => chosen.has(slot));
  const slotsToPublish = confirm && typeof confirm === 'object' && 'publish' in confirm ? (confirm.publish === 'all' ? changed : confirm.publish) : [];
  const buildSlots = slotsToPublish.filter((slot) => BRAND_ASSET_SPECS[slot].delivery === 'build');

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl space-y-1.5 text-sm">
            {data.published ? (
              <p>
                <Pill tone="brand">Live</Pill> <span className="font-semibold">Branding version {data.published.revision}</span>
                <span className="text-gray-500">
                  {' '}
                  · published {dateTime(data.published.publishedAt)}
                  {data.published.publishedBy ? ` by ${data.published.publishedBy}` : ''}
                </span>
              </p>
            ) : (
              <p>
                <Pill tone="gray">Built-in</Pill> Nothing published yet — every surface shows its built-in Aadione artwork.
              </p>
            )}
            {data.draft ? (
              <p className="text-gray-600">
                Draft saved {dateTime(data.draft.updatedAt)}
                {data.draft.updatedBy ? ` by ${data.draft.updatedBy}` : ''} — not visible outside this page.{' '}
                {changed.length === 0
                  ? 'It matches what is published.'
                  : `${changed.length} change${changed.length === 1 ? '' : 's'} to publish: ${changed.map((slot) => BRAND_ASSET_SPECS[slot].label).join(', ')}.`}
              </p>
            ) : (
              <p className="text-gray-500">No unpublished changes. Upload a file below to start a draft.</p>
            )}
            <p className="text-gray-500">
              Logos and the favicon update the Admin Panel, Seller Panel and website within about a minute of publishing, and the customer app the next time it
              refreshes — no app release needed. App icons need a new app release (see the last section).
            </p>
          </div>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setConfirm('discard')} disabled={!data.draft || busy}>
                Discard draft
              </Button>
              <Button variant="secondary" onClick={() => setConfirm({ publish: selected })} disabled={selected.length === 0 || busy}>
                Publish selected ({selected.length})
              </Button>
              <Button onClick={() => setConfirm({ publish: 'all' })} disabled={changed.length === 0 || busy}>
                Publish all changes
              </Button>
            </div>
          ) : (
            <Pill tone="gray">View only — changes need Configuration write access</Pill>
          )}
        </div>
        <div className="mt-3">
          <ErrorBanner message={actionError} />
        </div>
      </Card>

      <SurfacePreviews data={data} showDraft={showDraft} onShowDraft={setShowDraft} />

      {GROUP_ORDER.map((group) => {
        const slots = data.slots.filter((slot) => slot.spec.group === group);
        return (
          <Panel key={group} title={BRAND_ASSET_GROUP_LABELS[group]} bodyClass="space-y-4 px-5 pb-5">
            {group === 'native' ? <NativeNotice /> : null}
            {slots.map((slot) => (
              <SlotCard
                key={slot.slot}
                slot={slot}
                canEdit={canEdit}
                busy={busy}
                checked={chosen.has(slot.slot)}
                onCheck={(on) =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (on) next.add(slot.slot);
                    else next.delete(slot.slot);
                    return next;
                  })
                }
                onUpload={(file) => actions.upload.mutate({ slot: slot.slot, file })}
                onDefault={() => actions.reset.mutate(slot.slot)}
                onReuse={(revision) => actions.reuse.mutate({ slot: slot.slot, revision })}
                uploading={actions.upload.isPending && actions.upload.variables?.slot === slot.slot}
              />
            ))}
          </Panel>
        );
      })}

      <Panel title="Published versions">
        {data.history.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing published yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {data.history.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="min-w-0">
                  <span className="font-semibold">Version {item.revision}</span>
                  {data.published?.revision === item.revision ? <Pill tone="brand">Live</Pill> : null}
                  <span className="text-gray-500">
                    {' '}
                    · {dateTime(item.publishedAt)}
                    {item.publishedBy ? ` by ${item.publishedBy}` : ''}
                    {item.restoredFromRevision ? ` · restored from version ${item.restoredFromRevision}` : ''}
                  </span>
                  <span className="block break-words text-xs text-gray-500">
                    Changed: {item.changed.length > 0 ? item.changed.map((slot) => BRAND_ASSET_SPECS[slot].label).join(', ') : 'nothing'}
                  </span>
                </span>
                {canEdit && data.published?.revision !== item.revision ? (
                  <Button variant="secondary" onClick={() => setConfirm({ restore: item.id, revision: item.revision })} disabled={busy}>
                    Restore to draft
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {confirm && typeof confirm === 'object' && 'publish' in confirm ? (
        <Modal
          title={confirm.publish === 'all' ? 'Publish all branding changes?' : `Publish ${slotsToPublish.length} selected change${slotsToPublish.length === 1 ? '' : 's'}?`}
          subtitle={`Becomes branding version ${(data.history[0]?.revision ?? 0) + 1}`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const slots = confirm.publish === 'all' ? undefined : confirm.publish;
                  setConfirm(null);
                  actions.publish.mutate({ basedOnRevision: data.published?.revision ?? 0, slots }, { onSuccess: () => setChosen(new Set()) });
                }}
              >
                Publish now
              </Button>
            </div>
          }
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
            {slotsToPublish.map((slot) => (
              <li key={slot}>
                {BRAND_ASSET_SPECS[slot].label}
                {BRAND_ASSET_SPECS[slot].delivery === 'build' ? <span className="text-amber-700"> — needs a new app release</span> : null}
              </li>
            ))}
          </ul>
          {buildSlots.length > 0 ? (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
              App icons are not changed on anyone&apos;s phone by publishing. The published file becomes the source for the next Android / iOS release;
              phones keep the current icon until that release is approved, built and installed.
            </p>
          ) : null}
          <p className="mt-3 text-sm text-gray-600">Earlier versions stay in the history and can be restored.</p>
        </Modal>
      ) : null}

      {confirm === 'discard' ? (
        <Modal
          title="Discard the branding draft?"
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirm(null);
                  actions.discard.mutate();
                }}
              >
                Discard
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">Every unpublished change on this page is dropped. What is published does not change.</p>
        </Modal>
      ) : null}

      {confirm && typeof confirm === 'object' && 'restore' in confirm ? (
        <Modal
          title={`Restore branding version ${confirm.revision} to the draft?`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const id = confirm.restore;
                  setConfirm(null);
                  actions.restore.mutate(id);
                }}
              >
                Restore
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Every asset of version {confirm.revision} goes into the draft, replacing the current draft. Nothing changes for anyone until you publish.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One asset                                                                   */
/* -------------------------------------------------------------------------- */

function rulesOf(slot: BrandAssetSlot): string[] {
  const spec = BRAND_ASSET_SPECS[slot];
  const rules = [
    spec.formats.map((f) => f.toUpperCase()).join(' / '),
    `at least ${spec.minWidth} × ${spec.minHeight} px`,
    spec.aspect.min === spec.aspect.max ? 'square' : `${spec.aspect.min}:1 to ${spec.aspect.max}:1 wide`,
    'up to 5 MB',
  ];
  if (spec.transparency === 'required') rules.push('transparent background');
  if (spec.transparency === 'forbidden') rules.push('no transparency');
  return rules;
}

function SlotCard({
  slot,
  canEdit,
  busy,
  checked,
  onCheck,
  onUpload,
  onDefault,
  onReuse,
  uploading,
}: {
  slot: AdminBrandSlotDto;
  canEdit: boolean;
  busy: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onUpload: (file: File) => void;
  onDefault: () => void;
  onReuse: (revision: number) => void;
  uploading: boolean;
}) {
  const spec = slot.spec;
  const input = useRef<HTMLInputElement>(null);
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const isBuild = spec.delivery === 'build';

  async function pick(file: File | undefined) {
    if (!file) return;
    setLocalProblem(null);
    // A quick check in the browser; the server checks the file itself again (format, alpha, everything).
    const format = file.type.replace('image/', '');
    const size = await readImageSize(file);
    const problems = size
      ? brandAssetProblems(slot.slot, { format, width: size.width, height: size.height, bytes: file.size, hasAlpha: true, opaque: false }).filter(
          (problem) => !problem.includes('transparen'),
        )
      : ['This file is not an image we can read.'];
    if (file.size > BRAND_ASSET_MAX_BYTES) problems.push('The file must be 5 MB or smaller.');
    if (problems.length > 0) {
      setLocalProblem(problems.join(' '));
      return;
    }
    onUpload(file);
  }

  return (
    <article className="rounded-2xl border border-gray-200/80 p-4" aria-labelledby={`slot-${slot.slot}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl space-y-1">
          <h3 id={`slot-${slot.slot}`} className="flex flex-wrap items-center gap-2 font-semibold text-gray-900">
            {spec.label}
            {isBuild ? <Pill tone="amber">Needs a new app release</Pill> : <Pill tone="blue">Updates live</Pill>}
            {slot.changed ? <Pill tone="purple">Changed in draft</Pill> : null}
          </h3>
          <p className="text-sm text-gray-600">{spec.description}</p>
          <p className="text-xs text-gray-500">
            {isBuild ? 'Becomes: ' : 'Shown in: '}
            {spec.usedIn.join(' · ')}
          </p>
          <p className="text-xs text-gray-500">
            Rules: {rulesOf(slot.slot).join(', ')}. {spec.recommended}
          </p>
        </div>
        {canEdit && slot.changed ? (
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
            Include in “Publish selected”
          </label>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <AssetPreview title="Published now" asset={slot.published} slot={slot.slot} />
        <AssetPreview title={slot.changed ? 'In the draft' : 'Draft (same as published)'} asset={slot.draft} slot={slot.slot} muted={!slot.changed} />
      </div>

      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept={spec.formats.map((f) => `image/${f}`).join(',')}
            className="sr-only"
            aria-label={`Upload ${spec.label}`}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button onClick={() => input.current?.click()} disabled={busy}>
            {uploading ? 'Uploading and checking…' : slot.draft ? 'Replace' : 'Upload'}
          </Button>
          <Button variant="ghost" onClick={onDefault} disabled={busy || slot.draft === null}>
            Use built-in default
          </Button>
          {isBuild && slot.published ? (
            <a href={slot.published.pngUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-brand-600 hover:underline">
              Download published PNG (for the app build)
            </a>
          ) : null}
        </div>
      ) : null}
      {localProblem ? (
        <div className="mt-2">
          <ErrorBanner message={localProblem} />
        </div>
      ) : null}

      {slot.history.length > 0 ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-gray-700">Earlier files ({slot.history.length})</summary>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {slot.history.map((asset) => (
              <li key={asset.pngUrl} className="flex items-center gap-3 rounded-xl border border-gray-100 p-2">
                <img src={asset.url} alt="" className={`h-12 w-16 shrink-0 rounded object-contain ${CHECKER}`} loading="lazy" />
                <span className="min-w-0 flex-1 text-xs text-gray-600">
                  <span className="block truncate font-medium text-gray-800">{asset.fileName}</span>
                  Version {asset.revision} · {asset.width} × {asset.height}
                </span>
                {canEdit ? (
                  <Button variant="secondary" className="min-h-8 px-2.5 text-xs" onClick={() => onReuse(asset.revision)} disabled={busy}>
                    Use again
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

/** One asset on a light and a dark background (or the built-in note). */
function AssetPreview({ title, asset, slot, muted = false }: { title: string; asset: BrandAsset | null; slot: BrandAssetSlot; muted?: boolean }) {
  const square = BRAND_ASSET_SPECS[slot].aspect.max === 1;
  return (
    <figure className={`rounded-xl border border-gray-100 p-3 ${muted ? 'opacity-70' : ''}`}>
      <figcaption className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</figcaption>
      {asset ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className={`flex h-24 items-center justify-center rounded-lg ${CHECKER} bg-white p-2`}>
              <img src={asset.url} alt={`${BRAND_ASSET_SPECS[slot].label} on a light background`} className={`max-h-full max-w-full object-contain ${square ? 'h-20' : ''}`} />
            </div>
            <div className="flex h-24 items-center justify-center rounded-lg bg-[#16201B] p-2">
              <img src={asset.url} alt={`${BRAND_ASSET_SPECS[slot].label} on a dark background`} className={`max-h-full max-w-full object-contain ${square ? 'h-20' : ''}`} />
            </div>
          </div>
          <p className="mt-2 break-words text-xs text-gray-500">
            {asset.fileName} · {asset.width} × {asset.height} px · {kb(asset.bytes)}
            {asset.hasAlpha ? ' · transparent' : ''}
          </p>
        </>
      ) : (
        <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-lg bg-gray-50 text-center text-xs text-gray-500">
          {square ? <img src="/icon-512.png" alt="" className="h-12 w-12 rounded-xl" /> : <AadioneWordmark className="text-2xl" />}
          Built-in Aadione artwork
        </div>
      )}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

/** The asset a surface would show, with the clients' fallback chain (lib/branding brandAssetFor). */
function pickAsset(data: AdminBrandingDto, showDraft: boolean, chain: BrandAssetSlot[]): BrandAsset | null {
  for (const slot of chain) {
    const row = data.slots.find((s) => s.slot === slot);
    const asset = row ? (showDraft ? row.draft : row.published) : null;
    if (asset) return asset;
  }
  return null;
}

function Logo({ asset, fallback, className }: { asset: BrandAsset | null; fallback: ReactNode; className: string }) {
  return asset ? <img src={asset.url} alt="Aadione" className={`w-auto max-w-full object-contain ${className}`} /> : <>{fallback}</>;
}

function SurfacePreviews({ data, showDraft, onShowDraft }: { data: AdminBrandingDto; showDraft: boolean; onShowDraft: (on: boolean) => void }) {
  const a = useMemo(
    () => ({
      light: pickAsset(data, showDraft, ['logo_light', 'logo_main']),
      seller: pickAsset(data, showDraft, ['seller_app_logo', 'logo_light', 'logo_main']),
      dark: pickAsset(data, showDraft, ['logo_dark']),
      app: pickAsset(data, showDraft, ['customer_app_logo']),
      splash: pickAsset(data, showDraft, ['customer_splash_logo']),
      favicon: pickAsset(data, showDraft, ['favicon']),
    }),
    [data, showDraft],
  );
  const wordmark = <AadioneWordmark className="text-xl" />;
  return (
    <Panel
      title="Preview on every surface"
      action={
        <div className="flex gap-0.5 rounded-lg bg-gray-100 p-0.5" role="group" aria-label="Which branding to preview">
          {[
            { on: true, label: 'Draft' },
            { on: false, label: 'Published' },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={showDraft === option.on}
              onClick={() => onShowDraft(option.on)}
              className={`min-h-8 rounded-md px-3 text-xs font-semibold ${showDraft === option.on ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
      bodyClass="grid gap-4 px-5 pb-5 md:grid-cols-2"
    >
      <Mock label="Admin Panel header">
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
          <Logo asset={a.light} fallback={wordmark} className="h-7" />
          <span className="text-xs text-gray-400">Marketplace Admin</span>
        </div>
      </Mock>
      <Mock label="Seller Panel header">
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
          <Logo asset={a.seller} fallback={wordmark} className="h-7" />
          <span className="text-xs text-gray-400">Seller Panel</span>
        </div>
      </Mock>
      <Mock label="Website header and footer">
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <div className="flex items-center justify-between bg-white px-3 py-2">
            <Logo asset={a.light} fallback={wordmark} className="h-7" />
            <span className="text-xs text-gray-400">Home · About · Help</span>
          </div>
          <div className="flex items-center justify-between bg-[#16201B] px-3 py-2">
            {a.dark ? <Logo asset={a.dark} fallback={null} className="h-6" /> : <span className="text-sm font-bold text-white">Aadione (built-in white logo)</span>}
            <span className="text-xs text-white/60">Footer</span>
          </div>
        </div>
      </Mock>
      <Mock label="Browser tab (favicon)">
        <div className="flex items-center gap-2 rounded-t-lg border border-b-0 border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          {a.favicon ? <img src={a.favicon.variants?.png32 ?? a.favicon.url} alt="Favicon" className="h-4 w-4" /> : <img src="/favicon-32.png" alt="Built-in favicon" className="h-4 w-4" />}
          Aadione — Admin Panel
        </div>
        <div className="h-6 rounded-b-lg border border-gray-200 bg-white" />
      </Mock>
      <Mock label="Customer app — Home footer / About">
        <div className="flex items-center gap-3 rounded-2xl bg-[#F4F8F5] px-3 py-3">
          {a.app ? <img src={a.app.url} alt="Customer app logo" className="h-12 w-12 rounded-xl object-contain" /> : <img src="/icon-512.png" alt="Built-in app logo" className="h-12 w-12 rounded-xl" />}
          <span className="text-sm font-semibold text-gray-800">Aadione</span>
        </div>
      </Mock>
      <Mock label="Customer app — start-up screen">
        <div className="flex h-28 items-center justify-center rounded-2xl bg-white ring-1 ring-gray-200">
          {a.splash ? <img src={a.splash.url} alt="Start-up logo" className="max-h-20 max-w-[60%] object-contain" /> : <span className="text-xs text-gray-500">Built-in start-up logo</span>}
        </div>
      </Mock>
    </Panel>
  );
}

function Mock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1.5 text-xs font-semibold text-gray-500">{label}</figcaption>
      {children}
    </figure>
  );
}

function NativeNotice() {
  return (
    <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">These change only with a new app release.</p>
      <p className="mt-1">
        A server cannot change the icon of an app that is already installed. Publishing an icon here makes it the source for the next Android (AAB / APK) or
        iOS build — nothing is built automatically, and phones keep the current icon until that release is approved, built and installed. The steps are in
        docs/branding-native-assets.md.
      </p>
    </div>
  );
}

/**
 * Admin → App Updates.
 *
 * One policy for the customer app, per platform (shared/app-version.ts):
 *   - Optional: apps older than the LATEST version get a dismissible prompt;
 *   - Mandatory: apps older than the LATEST version must update;
 *   - in either mode, apps older than the MINIMUM supported version must
 *     update, and the server refuses their cart / order / payment requests.
 * Android and iOS are configured separately, so one never blocks the other.
 * Turning the policy off, or back to Optional, takes effect without a new app
 * build — within about a minute.
 *
 * The form validates with the same shared rules the server enforces.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APP_PLATFORMS,
  AppUpdateMode,
  AppUpdateStatus,
  Permission,
  evaluateAppUpdate,
  isValidVersion,
  normalizeAppUpdatePolicy,
  roleHasPermission,
  validateAppUpdatePolicy,
  type AppPlatform,
  type AppUpdatePolicy,
  type AppUpdatePolicyIssue,
} from '@shared';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Card, ErrorBanner, Field, Modal, Pill, Spinner, Toggle, inputClass } from '@/components/ui';

interface AdminPolicy {
  policy: AppUpdatePolicy;
  updatedAt: string | null;
}

/** Form state: every text field as typed (empty = not set). */
interface FormPlatform {
  latestVersion: string;
  minimumVersion: string;
  storeUrl: string;
}
interface FormState {
  enabled: boolean;
  mode: AppUpdateMode;
  blockUnversionedClients: boolean;
  title: string;
  message: string;
  releaseNotes: string;
  android: FormPlatform;
  ios: FormPlatform;
}

const PLATFORM_LABEL: Record<AppPlatform, string> = { android: 'Android', ios: 'iOS' };
const STORE_PLACEHOLDER: Record<AppPlatform, string> = {
  android: 'https://play.google.com/store/apps/details?id=in.adione.app',
  ios: 'https://apps.apple.com/in/app/…/id…',
};

function toForm(policy: AppUpdatePolicy): FormState {
  const platform = (p: AppUpdatePolicy['android']): FormPlatform => ({
    latestVersion: p.latestVersion ?? '',
    minimumVersion: p.minimumVersion ?? '',
    storeUrl: p.storeUrl ?? '',
  });
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    blockUnversionedClients: policy.blockUnversionedClients,
    title: policy.title,
    message: policy.message,
    releaseNotes: policy.releaseNotes ?? '',
    android: platform(policy.android),
    ios: platform(policy.ios),
  };
}

function toPolicy(form: FormState): AppUpdatePolicy {
  const empty = (value: string) => (value.trim() === '' ? null : value.trim());
  const platform = (p: FormPlatform) => ({
    latestVersion: empty(p.latestVersion),
    minimumVersion: empty(p.minimumVersion),
    storeUrl: empty(p.storeUrl),
  });
  return {
    enabled: form.enabled,
    mode: form.mode,
    blockUnversionedClients: form.blockUnversionedClients,
    title: form.title,
    message: form.message,
    releaseNotes: empty(form.releaseNotes),
    android: platform(form.android),
    ios: platform(form.ios),
  };
}

/** Does saving this make some app version that can use the app today unable to? */
function blocksMore(next: AppUpdatePolicy, saved: AppUpdatePolicy): boolean {
  if (!next.enabled) return false;
  if (next.blockUnversionedClients && !(saved.enabled && saved.blockUnversionedClients)) return true;
  if (next.mode === AppUpdateMode.MANDATORY && !(saved.enabled && saved.mode === AppUpdateMode.MANDATORY)) return true;
  return APP_PLATFORMS.some((platform) => {
    const n = next[platform];
    const s = saved[platform];
    const threshold = (p: typeof n, mode: AppUpdateMode) => (mode === AppUpdateMode.MANDATORY ? p.latestVersion ?? p.minimumVersion : p.minimumVersion);
    const nextThreshold = threshold(n, next.mode);
    const savedThreshold = saved.enabled ? threshold(s, saved.mode) : null;
    return nextThreshold !== null && nextThreshold !== savedThreshold;
  });
}

function issueFor(issues: AppUpdatePolicyIssue[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

function FieldError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return <p className="mt-1 text-xs font-medium text-danger-500">{message}</p>;
}

const STATUS_LABEL: Record<AppUpdateStatus, { text: string; tone: 'brand' | 'amber' | 'red' }> = {
  NONE: { text: 'No prompt — normal use', tone: 'brand' },
  OPTIONAL: { text: 'Optional update prompt', tone: 'amber' },
  REQUIRED: { text: 'Update required — app blocked', tone: 'red' },
};

export default function AppUpdatesPage() {
  const queryClient = useQueryClient();
  const role = useAuth((state) => state.user?.role);
  const canEdit = role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);

  const current = useQuery({
    queryKey: ['admin', 'app-update-policy'],
    queryFn: () => api.get<AdminPolicy>('/admin/app-update-policy'),
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ platform: AppPlatform; version: string }>({ platform: 'android', version: '' });

  useEffect(() => {
    if (current.data && form === null) setForm(toForm(current.data.policy));
  }, [current.data, form]);

  const save = useMutation({
    mutationFn: (policy: AppUpdatePolicy) => api.put<AdminPolicy>('/admin/app-update-policy', policy),
    onSuccess: (result) => {
      queryClient.setQueryData(['admin', 'app-update-policy'], result);
      setForm(toForm(result.policy));
      setTouched(false);
      setConfirming(false);
      setError(null);
      setSaved('App update settings saved. Customer apps pick them up within about a minute.');
    },
    onError: (err: unknown) => {
      setConfirming(false);
      setSaved(null);
      setError(err instanceof Error ? err.message : 'Could not save the app update settings.');
    },
  });

  const next = useMemo(() => (form ? toPolicy(form) : null), [form]);
  const issues = useMemo(() => (next ? validateAppUpdatePolicy(next) : []), [next]);

  if (current.isLoading || !form || !next) return <Spinner label="Loading app update settings…" />;
  if (current.isError || !current.data) {
    return <ErrorBanner message="Could not load the app update settings. Please refresh the page." />;
  }

  const savedPolicy = current.data.policy;
  const dirty = JSON.stringify(normalizeAppUpdatePolicy(next)) !== JSON.stringify(savedPolicy);

  function update(patch: Partial<FormState>) {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous));
    setTouched(true);
    setSaved(null);
  }
  function updatePlatform(platform: AppPlatform, patch: Partial<FormPlatform>) {
    setForm((previous) => (previous ? { ...previous, [platform]: { ...previous[platform], ...patch } } : previous));
    setTouched(true);
    setSaved(null);
  }

  function submit() {
    if (!next || issues.length > 0) {
      setTouched(true);
      return;
    }
    if (blocksMore(next, savedPolicy)) setConfirming(true);
    else save.mutate(next);
  }

  const showIssues = touched ? issues : [];
  const probeStatus = isValidVersion(probe.version) ? evaluateAppUpdate(next, probe.platform, probe.version) : null;

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />
      {saved && <p className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm font-medium text-brand-700">{saved}</p>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-semibold text-gray-900">Update policy</h2>
            <p className="mt-1 text-sm text-gray-600">
              Ask customers to install the newest Aadione app from the Play Store / App Store, or require it. Apps
              older than the <strong>minimum supported version</strong> must always update; in{' '}
              <strong>Mandatory</strong> mode every app older than the <strong>latest version</strong> must update too.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {current.data.updatedAt
                ? `Last saved ${new Date(current.data.updatedAt).toLocaleString('en-IN')}`
                : 'Never saved — the built-in default (off) applies.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Pill tone={savedPolicy.enabled ? (savedPolicy.mode === AppUpdateMode.MANDATORY ? 'red' : 'brand') : 'gray'}>
              {savedPolicy.enabled ? (savedPolicy.mode === AppUpdateMode.MANDATORY ? 'Live · Mandatory' : 'Live · Optional') : 'Off'}
            </Pill>
          </div>
        </div>

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 px-4 py-3">
            <div>
              <p className="font-medium text-gray-800">Update policy enabled</p>
              <p className="text-sm text-gray-600">Off = no prompts and no version checks.</p>
            </div>
            <Toggle checked={form.enabled} onChange={(enabled) => update({ enabled })} label="Update policy enabled" disabled={!canEdit} />
          </div>

          <div className="rounded-xl border border-gray-200 px-4 py-3">
            <p className="font-medium text-gray-800">Update mode</p>
            <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Update mode">
              {[AppUpdateMode.OPTIONAL, AppUpdateMode.MANDATORY].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={form.mode === mode}
                  disabled={!canEdit}
                  onClick={() => update({ mode })}
                  className={`min-h-11 rounded-xl border px-4 text-sm font-semibold transition disabled:opacity-50 ${
                    form.mode === mode
                      ? mode === AppUpdateMode.MANDATORY
                        ? 'border-danger-500 bg-danger-50 text-danger-500'
                        : 'border-brand-500 bg-brand-50 text-brand-600'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {mode === AppUpdateMode.OPTIONAL ? 'Optional — "Later" allowed' : 'Mandatory — must update'}
                </button>
              ))}
            </div>
            <FieldError message={issueFor(showIssues, 'mode')} />
          </div>
        </div>

        {form.enabled && form.mode === AppUpdateMode.MANDATORY && (
          <p className="mt-4 rounded-xl bg-danger-50 px-3.5 py-2.5 text-sm text-gray-800">
            <strong className="text-danger-500">Mandatory:</strong> every customer whose app is older than the latest
            version below will see only the “Update required” screen, and the server will refuse their cart, checkout,
            order and payment requests until they update. Make sure the new version is already live in the store for
            that platform.
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {APP_PLATFORMS.map((platform) => {
          const p = form[platform];
          return (
            <Card key={platform}>
              <h2 className="mb-3 font-semibold text-gray-900">{PLATFORM_LABEL[platform]}</h2>
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Latest version" hint="The newest version in the store, e.g. 1.0.9">
                    <input
                      className={inputClass}
                      value={p.latestVersion}
                      onChange={(event) => updatePlatform(platform, { latestVersion: event.target.value })}
                      placeholder="1.0.9"
                      inputMode="decimal"
                      disabled={!canEdit}
                    />
                    <FieldError message={issueFor(showIssues, `${platform}.latestVersion`)} />
                  </Field>
                  <Field label="Minimum supported version" hint="Older apps must update. Empty = no minimum.">
                    <input
                      className={inputClass}
                      value={p.minimumVersion}
                      onChange={(event) => updatePlatform(platform, { minimumVersion: event.target.value })}
                      placeholder="1.0.8"
                      inputMode="decimal"
                      disabled={!canEdit}
                    />
                    <FieldError message={issueFor(showIssues, `${platform}.minimumVersion`)} />
                  </Field>
                </div>
                <Field
                  label={platform === 'android' ? 'Play Store link' : 'App Store link'}
                  hint={
                    platform === 'android'
                      ? 'The official listing on play.google.com.'
                      : 'The official listing on apps.apple.com — add it once the iOS app is published.'
                  }
                >
                  <input
                    className={inputClass}
                    value={p.storeUrl}
                    onChange={(event) => updatePlatform(platform, { storeUrl: event.target.value })}
                    placeholder={STORE_PLACEHOLDER[platform]}
                    disabled={!canEdit}
                  />
                  <FieldError message={issueFor(showIssues, `${platform}.storeUrl`)} />
                </Field>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <h2 className="mb-3 font-semibold text-gray-900">What customers see</h2>
        <div className="space-y-4">
          <Field label="Title" required>
            <input className={inputClass} value={form.title} onChange={(event) => update({ title: event.target.value })} maxLength={80} disabled={!canEdit} />
            <FieldError message={issueFor(showIssues, 'title')} />
          </Field>
          <Field label="Message" required>
            <textarea
              className={`${inputClass} min-h-24`}
              value={form.message}
              onChange={(event) => update({ message: event.target.value })}
              maxLength={500}
              disabled={!canEdit}
            />
            <FieldError message={issueFor(showIssues, 'message')} />
          </Field>
          <Field label="Release notes" hint="Optional — shown under “What's new”.">
            <textarea
              className={`${inputClass} min-h-24`}
              value={form.releaseNotes}
              onChange={(event) => update({ releaseNotes: event.target.value })}
              maxLength={2000}
              disabled={!canEdit}
            />
            <FieldError message={issueFor(showIssues, 'releaseNotes')} />
          </Field>
          <div className="flex items-start justify-between gap-4 rounded-xl border border-gray-200 px-4 py-3">
            <div>
              <p className="font-medium text-gray-800">Also block app versions that do not report a version</p>
              <p className="text-sm text-gray-600">
                Apps released before version checks existed cannot show the update screen; with this on, the server
                refuses their cart, order and payment requests with “Please update Aadione”. Leave off until most
                customers have a version-aware app.
              </p>
            </div>
            <Toggle
              checked={form.blockUnversionedClients}
              onChange={(blockUnversionedClients) => update({ blockUnversionedClients })}
              label="Block apps that do not report a version"
              disabled={!canEdit}
            />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 font-semibold text-gray-900">Check a version</h2>
        <p className="mb-3 text-sm text-gray-600">What an installed app would see with the settings on this page (saved or not).</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Platform">
            <select
              className={inputClass}
              value={probe.platform}
              onChange={(event) => setProbe({ ...probe, platform: event.target.value as AppPlatform })}
            >
              {APP_PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>
                  {PLATFORM_LABEL[platform]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Installed version">
            <input className={inputClass} value={probe.version} onChange={(event) => setProbe({ ...probe, version: event.target.value })} placeholder="1.0.8" />
          </Field>
          <div className="pb-2">
            {probe.version.trim() === '' ? null : probeStatus === null ? (
              <Pill tone="gray">Not a valid version</Pill>
            ) : (
              <Pill tone={STATUS_LABEL[probeStatus].tone}>{STATUS_LABEL[probeStatus].text}</Pill>
            )}
          </div>
        </div>
      </Card>

      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {touched && issues.length > 0 && <p className="text-sm font-medium text-danger-500">Fix the highlighted fields to save.</p>}
          <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => { setForm(toForm(savedPolicy)); setTouched(false); setError(null); }}>
            Discard changes
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save app update settings'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-gray-500">You can view these settings; changing them needs configuration access.</p>
      )}

      {confirming && (
        <Modal
          title="Block older app versions?"
          subtitle="Please confirm before this goes live."
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(next)}>
                {save.isPending ? 'Saving…' : 'Yes, enforce this update'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-gray-700">
            <p>
              Customers on the versions below will see only the <strong>Update required</strong> screen, and the
              server will refuse their cart, checkout, order and payment requests until they install the update.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {APP_PLATFORMS.map((platform) => {
                const p = next[platform];
                const threshold = next.mode === AppUpdateMode.MANDATORY ? p.latestVersion ?? p.minimumVersion : p.minimumVersion;
                return (
                  <li key={platform}>
                    {PLATFORM_LABEL[platform]}:{' '}
                    {threshold ? (
                      <>
                        versions older than <strong>{threshold}</strong> must update
                      </>
                    ) : (
                      'not affected'
                    )}
                  </li>
                );
              })}
              {next.blockUnversionedClients && <li>Apps that do not report a version (older builds) are refused too.</li>}
            </ul>
            <p>Only confirm once the required version is live in the store. You can switch back to Optional or off at any time — no app release needed.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

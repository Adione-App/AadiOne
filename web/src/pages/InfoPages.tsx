/**
 * Information Pages — Privacy Policy, Terms & Conditions, About Aadione.
 *
 * Edit → Save draft → Preview → Publish, with version history and restore
 * (lib/infoPages.ts; server: content/info-page.service.ts). Customers — in the
 * app, on the website and at the public link — only ever see the published
 * page.
 *
 * Version and "Last updated" are set by the server when publishing (the next
 * revision number; the publish day in India) — they are not typed here, a
 * saved draft never moves them, and publishing a restored version creates a
 * new version. The only date an admin sets is an optional FUTURE "takes
 * effect" date, for wording published ahead of the day it applies from.
 *
 * The text is plain text only (headings, paragraphs, bullet lists) — nothing
 * typed here is ever treated as HTML. Business and contact details are never
 * typed in: insert a {{SETTING}} and it is filled from Configuration each time
 * the page is shown (a line whose setting is empty is left out).
 *
 * Reading needs Configuration access; editing and publishing need
 * Configuration write access (the server enforces both).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  INFO_PAGE_SLUGS,
  INFO_PAGE_TITLES,
  Permission,
  infoPageUnconfirmed,
  roleHasPermission,
  type InfoPageBlock,
  type InfoPageContent,
  type InfoPagePreviewDto,
  type InfoPageSlug,
} from '@shared';
import { Button, Card, ErrorBanner, Field, Modal, Panel, Pill, Spinner, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { previewInfoPage, useInfoPageEditor } from '@/lib/infoPages';
import { OWNER_FACTS, TECHNICAL_FACTS, type ChecklistItem } from '@/lib/legalChecklist';

const errorText = (error: unknown): string | null => (error instanceof Error ? error.message : error ? 'Something went wrong.' : null);
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const UNPUBLISHED_NOTE: Record<InfoPageSlug, string> = {
  privacy:
    'Customers currently see the OLD built-in privacy wording, written for the earlier single-shop service. It is out of date (it describes direct UPI payments and an anonymised 8-year record that the system does not keep). Publish the reviewed policy to replace it in the app, on the website and at the public link.',
  terms:
    'Customers currently see the OLD built-in terms, written for the earlier single-shop service and out of date (for example direct UPI payments). Publish the reviewed terms to replace them in the app, on the website and at the public link.',
  about: 'Not published yet — the app shows a short built-in introduction and the website shows no About text until you publish.',
};

/** Dates the legal wording has to keep up with (verify each against the official Gazette before relying on it). */
const LEGAL_CALENDAR: { date: string; text: string }[] = [
  { date: 'In force', text: 'IT Act 2000 + SPDI Rules 2011 (privacy); Consumer Protection (E-Commerce) Rules 2020 (seller details, grievance officer, 48 h / 1 month).' },
  { date: '13/14 Nov 2026', text: 'DPDP Rules 2025 — consent-manager provisions (rule 4), one year after publication. Exact day: legal review.' },
  { date: '1 Jan 2027', text: 'Consumer Protection (E-Commerce) (Amendment) Rules 2026 — PIB release of 10 Sep 2026 found; Gazette text (reported G.S.R. 789(E)) NOT read. Publish updated Terms with this "takes effect" date after legal review.' },
  { date: 'May 2027', text: 'DPDP main duties (notice, consent, rights, breach reporting) — 18 months after the Rules were notified on 14 Nov 2025 (official PIB document). Exact day: legal review.' },
];

export default function InfoPagesPage() {
  const [slug, setSlug] = useState<InfoPageSlug>('privacy');
  return (
    <div className="space-y-5">
      <nav aria-label="Information pages" className="flex flex-wrap gap-2">
        {INFO_PAGE_SLUGS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSlug(option)}
            aria-pressed={slug === option}
            className={`rounded-full border px-4 py-2 text-sm font-semibold ${
              slug === option ? 'border-brand-500 bg-brand-500 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-brand-200'
            }`}
          >
            {INFO_PAGE_TITLES[option]}
          </button>
        ))}
      </nav>
      <PageEditor key={slug} slug={slug} />
    </div>
  );
}

function PageEditor({ slug }: { slug: InfoPageSlug }) {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);
  const editor = useInfoPageEditor(slug);
  const { doc, content, dirty } = editor;
  const [preview, setPreview] = useState<InfoPagePreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'publish' | 'template' | 'discard' | { restore: string; revision: number }>(null);
  // Privacy / Terms: ask signed-in customers to accept the new version (the first time always).
  const [askAcceptance, setAskAcceptance] = useState(false);

  if (doc.isLoading) return <Spinner />;
  if (doc.isError || !doc.data) return <ErrorBanner message={errorText(doc.error) ?? 'Could not load this page.'} />;
  const data = doc.data;

  const busy = editor.save.isPending || editor.discard.isPending || editor.publish.isPending || editor.restore.isPending;
  const actionError = errorText(editor.save.error ?? editor.discard.error ?? editor.publish.error ?? editor.restore.error);
  const unconfirmed = content ? infoPageUnconfirmed(content) : [];

  async function runPreview() {
    if (!content) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(await previewInfoPage(slug, content));
    } catch (error) {
      setPreviewError(errorText(error));
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl space-y-1.5 text-sm">
            {data.published ? (
              <>
                <p>
                  <Pill tone="brand">Live</Pill>{' '}
                  <span className="font-semibold">
                    Version {data.published.version} · Last updated {data.published.lastUpdatedLabel}
                  </span>
                  {data.published.effectiveDate ? <span className="text-gray-700"> · takes effect {data.published.effectiveDate}</span> : null}
                </p>
                <p className="text-gray-500">
                  Published {dateTime(data.published.publishedAt)}
                  {data.published.publishedBy ? ` by ${data.published.publishedBy}` : ''}
                  {data.published.restoredFromVersion ? ` · re-published text of version ${data.published.restoredFromVersion}` : ''}
                </p>
              </>
            ) : (
              <p className={slug === 'about' ? 'text-gray-600' : 'rounded-xl bg-red-50 px-3 py-2 text-red-800'}>
                <Pill tone={slug === 'about' ? 'amber' : 'red'}>Not published</Pill> {UNPUBLISHED_NOTE[slug]}
                {data.live.lastUpdatedLabel ? ` (Built-in wording dated ${data.live.lastUpdatedLabel}.)` : ''}
              </p>
            )}
            {data.draft ? (
              <p className="text-gray-600">
                Draft saved {dateTime(data.draft.updatedAt)}
                {data.draft.updatedBy ? ` by ${data.draft.updatedBy}` : ''} — not visible to customers. Saving a draft never changes the public date.
                {data.draft.content.restoredFromVersion ? ` Based on the text of version ${data.draft.content.restoredFromVersion}.` : ''}
              </p>
            ) : null}
            <p className="text-gray-500">
              Publishing creates <span className="font-semibold text-gray-700">Version {data.nextVersion}</span>, with "Last updated" set to the day you publish.
            </p>
            {dirty ? <p className="font-medium text-amber-700">You have unsaved changes.</p> : null}
          </div>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => (content ? setConfirm('template') : editor.replace(data.template))} disabled={busy}>
                Load Aadione template
              </Button>
              <Button variant="secondary" onClick={() => void runPreview()} disabled={!content || previewing}>
                {previewing ? 'Preparing preview…' : 'Preview'}
              </Button>
              <Button onClick={() => editor.save.mutate()} disabled={!content || !dirty || busy}>
                Save draft
              </Button>
              <Button variant="ghost" onClick={() => setConfirm('discard')} disabled={!data.draft || busy}>
                Discard draft
              </Button>
              <Button
                onClick={() => {
                  setAskAcceptance(slug !== 'about' && !data.acceptanceEverRequired);
                  setConfirm('publish');
                }}
                disabled={!data.draft || dirty || busy}
              >
                Publish
              </Button>
            </div>
          ) : (
            <Pill tone="gray">View only — publishing needs Configuration write access</Pill>
          )}
        </div>
        <div className="mt-3 space-y-2">
          <ErrorBanner message={actionError} />
          <ErrorBanner message={previewError} />
          {canEdit && data.draft && dirty ? <p className="text-xs text-gray-500">Save the draft before publishing.</p> : null}
        </div>
      </Card>

      <SettingsPanel slug={slug} settings={data.settings} missingRequired={data.missingRequired} />

      {content && unconfirmed.length > 0 ? <UnconfirmedPanel items={unconfirmed} /> : null}

      {slug !== 'about' ? <PublishingChecklist settings={data.settings} /> : null}

      {slug !== 'about' ? <LegalCalendarPanel /> : null}

      {content ? (
        <ContentEditor content={content} canEdit={canEdit} update={editor.update} />
      ) : (
        <Card>
          <p className="text-sm text-gray-600">
            This page has no draft yet.{' '}
            {canEdit ? 'Start from the Aadione template, review every section, then save, preview and publish.' : ''}
          </p>
          {canEdit ? (
            <div className="mt-3">
              <Button onClick={() => editor.replace(data.template)}>Start from the Aadione template</Button>
            </div>
          ) : null}
        </Card>
      )}

      <Panel title="Version history">
        {data.history.length === 0 ? (
          <p className="text-sm text-gray-500">No earlier versions yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {data.history.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold">Version {item.version}</span> · Last updated {item.lastUpdatedLabel}
                  {item.effectiveDate ? ` · takes effect ${item.effectiveDate}` : ''}{' '}
                  <span className="text-gray-500">
                    (published {dateTime(item.publishedAt)}
                    {item.publishedBy ? ` by ${item.publishedBy}` : ''}
                    {item.restoredFromVersion ? `; re-published text of version ${item.restoredFromVersion}` : ''}
                    {item.requiresAcceptance ? '; customers asked to accept' : ''})
                  </span>
                </span>
                {canEdit ? (
                  <Button variant="secondary" onClick={() => setConfirm({ restore: item.id, revision: item.revision })} disabled={busy}>
                    Restore text to draft
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {preview ? <PreviewModal preview={preview} onClose={() => setPreview(null)} /> : null}

      {confirm === 'publish' ? (
        <Modal
          title={`Publish ${INFO_PAGE_TITLES[slug]}?`}
          subtitle={`Becomes Version ${data.nextVersion}, last updated today${data.draft?.content.effectiveDate ? ` · takes effect ${data.draft.content.effectiveDate} if that is later` : ''}`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={() => { setConfirm(null); editor.publish.mutate(slug === 'about' ? undefined : askAcceptance); }}>Publish now</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Customers see it in the app, on the website and at the public page link within about a minute. Only this page is published — the other pages are
            not changed. Make sure the wording has been reviewed and, for the Privacy Policy and Terms, approved by a qualified legal adviser.
          </p>
          {slug !== 'about' ? (
            <label className="mt-4 flex items-start gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={askAcceptance}
                disabled={!data.acceptanceEverRequired}
                onChange={(e) => setAskAcceptance(e.target.checked)}
              />
              <span>
                Ask signed-in customers to accept this version in the app.
                {data.acceptanceEverRequired
                  ? ' Use it for significant changes; leave it off for corrections so customers are not asked again.'
                  : ' The first published version is always accepted by customers once.'}
                {' '}Customers are asked only when both the Privacy Policy and the Terms are published.
              </span>
            </label>
          ) : null}
        </Modal>
      ) : null}
      {confirm === 'template' ? (
        <Modal
          title="Replace the text with the Aadione template?"
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={() => { setConfirm(null); editor.replace(data.template); }}>Replace</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">The text on screen is replaced (nothing is saved until you press Save draft).</p>
        </Modal>
      ) : null}
      {confirm === 'discard' ? (
        <Modal
          title="Discard the draft?"
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => { setConfirm(null); editor.discard.mutate(); }}>Discard</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">Unpublished changes are deleted. The published version (if any) is not affected.</p>
        </Modal>
      ) : null}
      {confirm && typeof confirm === 'object' ? (
        <Modal
          title={`Restore the text of version ${confirm.revision} to the draft?`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={() => { const id = confirm.restore; setConfirm(null); editor.restore.mutate(id); }}>Restore</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Its text becomes the draft; customers keep seeing the current version until you publish. Publishing it creates Version {data.nextVersion}, dated the
            day you publish — version {confirm.revision} keeps its own date in the history.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

function SettingsPanel({
  slug,
  settings,
  missingRequired,
}: {
  slug: InfoPageSlug;
  settings: { token: string; label: string; filled: boolean; required: boolean }[];
  missingRequired: string[];
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (token: string) => {
    void navigator.clipboard?.writeText(`{{${token}}}`).then(() => setCopied(token)).catch(() => undefined);
  };
  return (
    <Panel
      title="Settings used by this page"
      action={
        <Link to="/settings" className="text-sm font-semibold text-brand-600 hover:underline">
          Edit in Configuration
        </Link>
      }
    >
      {missingRequired.length > 0 && slug !== 'about' ? (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Required before publishing: {missingRequired.join(', ')}.
        </p>
      ) : null}
      <p className="mb-2 text-xs text-gray-500">
        Click a setting to copy its placeholder, then paste it into the text. A line whose setting is empty is not shown to customers.
      </p>
      <div className="flex flex-wrap gap-2">
        {settings.map((setting) => (
          <button
            key={setting.token}
            type="button"
            onClick={() => copy(setting.token)}
            title={`{{${setting.token}}}`}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              setting.filled ? 'border-brand-200 bg-brand-50 text-brand-700' : setting.required ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-200 bg-gray-50 text-gray-500'
            }`}
          >
            {setting.label}
            {setting.required ? ' *' : ''} {setting.filled ? '✓' : '— empty'}
            {copied === setting.token ? ' (copied)' : ''}
          </button>
        ))}
      </div>
    </Panel>
  );
}

function move<T>(list: T[], index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item!);
}

function UnconfirmedPanel({ items }: { items: { section: string; text: string }[] }) {
  return (
    <Panel title={`Unresolved items (${items.length})`}>
      <p className="mb-3 text-sm text-amber-800">
        Each «TO CONFIRM» note needs the owner's decision (and legal review) — replace it with the final wording. The page cannot be published while any is left.
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
        {items.map((item, i) => (
          <li key={i}>
            <span className="font-semibold">{item.section}:</span> {item.text}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function PublishingChecklist({ settings }: { settings: { configKey: string; filled: boolean }[] }) {
  const filled = new Map(settings.map((setting) => [setting.configKey, setting.filled]));
  const settingState = (item: ChecklistItem): 'done' | 'missing' | null => {
    if (!item.settings) return null;
    const known = item.settings.filter((key) => filled.has(key));
    if (known.length === 0) return null;
    // "email or phone" style items count as done when any is filled.
    const anyOf = item.label.includes(' or ');
    const done = anyOf ? known.some((key) => filled.get(key)) : known.every((key) => filled.get(key));
    return done ? 'done' : 'missing';
  };
  return (
    <Panel title="Publishing checklist">
      <p className="mb-3 text-xs text-gray-500">
        Nothing here is invented: each open item needs the proprietor's answer, a check in a hosting dashboard, or legal review. «TO CONFIRM» notes stay in
        the draft — and block publishing — until replaced with the confirmed wording.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-900">A. Proprietor to confirm</h3>
          <ul className="space-y-2 text-sm">
            {OWNER_FACTS.map((item) => {
              const state = settingState(item);
              return (
                <li key={item.label} className="flex gap-2">
                  <span className="mt-0.5 shrink-0">
                    {state === 'done' ? <Pill tone="brand">Entered</Pill> : state === 'missing' ? <Pill tone="amber">Missing</Pill> : <Pill tone="gray">Decide</Pill>}
                  </span>
                  <span>
                    <span className="font-medium text-gray-900">{item.label}</span>
                    <span className="block text-xs text-gray-500">{item.note}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-900">B. Technical facts (audit of 7 November 2026)</h3>
          <ul className="space-y-2 text-sm">
            {TECHNICAL_FACTS.map((item) => (
              <li key={item.label} className="flex gap-2">
                <span className="mt-0.5 shrink-0">{item.status === 'verified' ? <Pill tone="brand">Verified</Pill> : <Pill tone="amber">Open</Pill>}</span>
                <span>
                  <span className="font-medium text-gray-900">{item.label}</span>
                  <span className="block text-xs text-gray-500">{item.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Panel>
  );
}

function LegalCalendarPanel() {
  return (
    <Panel title="Legal calendar">
      <p className="mb-2 text-xs text-gray-500">
        Wording must not present rules that have not started as already in force. For a future change, publish the reviewed page with a "takes effect" date.
      </p>
      <ul className="space-y-1.5 text-sm text-gray-700">
        {LEGAL_CALENDAR.map((row) => (
          <li key={row.date} className="flex gap-3">
            <span className="w-24 shrink-0 font-semibold text-gray-900">{row.date}</span>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ContentEditor({
  content,
  canEdit,
  update,
}: {
  content: InfoPageContent;
  canEdit: boolean;
  update: (change: (draft: InfoPageContent) => void) => void;
}) {
  return (
    <Card>
      <fieldset disabled={!canEdit} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Title" required>
            <input className={inputClass} value={content.title} maxLength={120} onChange={(e) => update((d) => { d.title = e.target.value; })} />
          </Field>
          <Field
            label="Takes effect on (optional)"
            hint="Leave empty: applies from publication. A future date is shown to customers as 'takes effect on'; an earlier date is ignored — pages are never backdated."
          >
            <div className="flex gap-2">
              <input type="date" className={inputClass} value={content.effectiveDate} onChange={(e) => update((d) => { d.effectiveDate = e.target.value; })} />
              {content.effectiveDate ? <Button variant="ghost" onClick={() => update((d) => { d.effectiveDate = ''; })}>Clear</Button> : null}
            </div>
          </Field>
        </div>

        {content.sections.map((section, s) => (
          <div key={s} className="rounded-2xl border border-gray-200 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1">
                <Field label={`Section ${s + 1} heading`} required>
                  <input className={inputClass} value={section.heading} maxLength={160} onChange={(e) => update((d) => { d.sections[s]!.heading = e.target.value; })} />
                </Field>
              </div>
              <Button variant="ghost" onClick={() => update((d) => move(d.sections, s, -1))} disabled={s === 0}>↑</Button>
              <Button variant="ghost" onClick={() => update((d) => move(d.sections, s, 1))} disabled={s === content.sections.length - 1}>↓</Button>
              <Button variant="ghost" onClick={() => update((d) => { d.sections.splice(s, 1); })}>Remove section</Button>
            </div>
            <div className="mt-3 space-y-3">
              {section.blocks.map((block, b) => (
                <BlockEditor
                  key={b}
                  block={block}
                  first={b === 0}
                  last={b === section.blocks.length - 1}
                  onChange={(next) => update((d) => { d.sections[s]!.blocks[b] = next; })}
                  onMove={(delta) => update((d) => move(d.sections[s]!.blocks, b, delta))}
                  onRemove={() => update((d) => { d.sections[s]!.blocks.splice(b, 1); })}
                />
              ))}
              <div className="flex gap-2">
                <Button variant="soft" onClick={() => update((d) => { d.sections[s]!.blocks.push({ type: 'paragraph', text: '' }); })}>+ Paragraph</Button>
                <Button variant="soft" onClick={() => update((d) => { d.sections[s]!.blocks.push({ type: 'bullets', items: [''] }); })}>+ Bullet list</Button>
              </div>
            </div>
          </div>
        ))}
        <Button variant="soft" onClick={() => update((d) => { d.sections.push({ heading: '', blocks: [{ type: 'paragraph', text: '' }] }); })}>+ Add section</Button>
      </fieldset>
    </Card>
  );
}

function BlockEditor({
  block,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  block: InfoPageBlock;
  first: boolean;
  last: boolean;
  onChange: (next: InfoPageBlock) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const isList = block.type === 'bullets';
  const value = isList ? block.items.join('\n') : block.text;
  return (
    <div className="rounded-xl bg-gray-50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <select
          className="rounded-lg border border-gray-200 bg-white px-2 py-1"
          value={block.type}
          aria-label="Block type"
          onChange={(e) => onChange(e.target.value === 'bullets' ? { type: 'bullets', items: value.split('\n') } : { type: 'paragraph', text: value })}
        >
          <option value="paragraph">Paragraph</option>
          <option value="bullets">Bullet list (one point per line)</option>
        </select>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => onMove(-1)} disabled={first}>↑</Button>
        <Button variant="ghost" onClick={() => onMove(1)} disabled={last}>↓</Button>
        <Button variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
      <textarea
        className={`${inputClass} min-h-24`}
        value={value}
        aria-label={isList ? 'Bullet points, one per line' : 'Paragraph text'}
        onChange={(e) => onChange(isList ? { type: 'bullets', items: e.target.value.split('\n') } : { type: 'paragraph', text: e.target.value })}
      />
    </div>
  );
}

function PreviewModal({ preview, onClose }: { preview: InfoPagePreviewDto; onClose: () => void }) {
  const { page } = preview;
  return (
    <Modal
      title={`Preview — ${page.title}`}
      subtitle={`If published now: Last updated ${preview.onPublish.lastUpdatedLabel} · Version ${preview.onPublish.version}${preview.onPublish.effectiveLabel ? ` · takes effect ${preview.onPublish.effectiveLabel}` : ''} · with today's settings. Not public.`}
      onClose={onClose}
      wide
    >
      <div className="space-y-3">
        {preview.missingRequired.length > 0 ? (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Publishing is blocked until these settings are filled: {preview.missingRequired.join(', ')}.
          </p>
        ) : null}
        {preview.unconfirmed.length > 0 ? (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {preview.unconfirmed.length} «TO CONFIRM» note{preview.unconfirmed.length === 1 ? '' : 's'} must be replaced before publishing.
          </p>
        ) : null}
        {page.missing.length > 0 ? (
          <p className="text-xs text-gray-500">Lines using these empty settings are hidden from customers: {page.missing.join(', ')}.</p>
        ) : null}
        <article className="rounded-2xl border border-gray-200 p-5 text-sm leading-6 text-gray-800">
          {page.sections.map((section, s) => (
            <section key={s} className="mb-4">
              <h3 className="mb-1 text-base font-semibold text-brand-700">{section.heading}</h3>
              {section.blocks.map((block, b) =>
                block.type === 'paragraph' ? (
                  <p key={b} className="my-1.5 whitespace-pre-line">{block.text}</p>
                ) : (
                  <ul key={b} className="my-1.5 list-disc pl-5">
                    {block.items.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                ),
              )}
            </section>
          ))}
        </article>
      </div>
    </Modal>
  );
}

/**
 * Legal & Policies — a small CMS for the customer Privacy Policy, Terms,
 * Refund & Cancellation, Shipping & Delivery and Cookie policies, the Seller
 * Terms and Seller Privacy Policy, and About Aadione.
 *
 * Two views (both in the URL, so a refresh or Back keeps your place):
 *   - the list: Customers / Sellers / Everyone tabs, one card per policy with
 *     its status, last-updated date and Edit;
 *   - the editor (?edit=<slug>): title, optional "takes effect" date and the
 *     sections (headings, paragraphs, bullet lists), with Save draft,
 *     Preview, Publish and Version history.
 *
 * Same server as before (lib/infoPages.ts; content/info-page.service.ts):
 * customers — in the app, on the website and at the public link — only ever
 * see the published version; a draft never changes it, publishing asks for
 * confirmation, and every earlier version stays in the history. Version and
 * "Last updated" are set by the server when publishing.
 *
 * The text is plain text only (never HTML). Business and contact details are
 * {{SETTING}} placeholders filled from Configuration each time the page is
 * shown (a line whose setting is empty is left out). The server still refuses
 * to publish a page with a «TO CONFIRM» note or a required setting empty; the
 * editor says so in one line next to Publish.
 *
 * Reading needs Configuration access; editing and publishing need
 * Configuration write access (the server enforces both).
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  INFO_PAGE_AUDIENCE,
  INFO_PAGE_SLUGS,
  INFO_PAGE_TITLES,
  INFO_PAGE_UNCONFIRMED_MARKER,
  Permission,
  asksForAcceptance,
  infoPageUnconfirmed,
  roleHasPermission,
  type AdminInfoPageDto,
  type InfoPageAudience,
  type InfoPageBlock,
  type InfoPageContent,
  type InfoPagePreviewDto,
  type InfoPageSettingDto,
  type InfoPageSlug,
} from '@shared';
import { Button, Card, ErrorBanner, Field, Modal, Pill, Spinner, Surface, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { apiAbsoluteUrl } from '@/lib/api';
import { previewInfoPage, useAdminInfoPage, useInfoPageEditor } from '@/lib/infoPages';

const errorText = (error: unknown): string | null => (error instanceof Error ? error.message : error ? 'Something went wrong.' : null);
const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const TABS: { label: string; audience: InfoPageAudience }[] = [
  { label: 'Customers', audience: 'customer' },
  { label: 'Sellers', audience: 'seller' },
  { label: 'Everyone', audience: 'general' },
];

const isSlug = (value: string | null): value is InfoPageSlug => value !== null && (INFO_PAGE_SLUGS as readonly string[]).includes(value);
const isAudience = (value: string | null): value is InfoPageAudience => TABS.some((tab) => tab.audience === value);

/** The public web page of a page (or of one earlier version). */
const publicPageUrl = (slug: InfoPageSlug, version?: number) =>
  apiAbsoluteUrl(version ? `/legal/${slug}/versions/${version}/page` : `/legal/${slug}/page`);

const LEAVE_PROMPT = 'You have unsaved changes to this policy. Leave without saving?';

function useCanEdit(): boolean {
  const role = useAuth((state) => state.user?.role);
  return role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);
}

export default function InfoPagesPage() {
  const [params, setParams] = useSearchParams();
  const editing = params.get('edit');
  const tabParam = params.get('tab');

  if (isSlug(editing)) {
    return <PolicyEditor key={editing} slug={editing} onBack={() => setParams({ tab: INFO_PAGE_AUDIENCE[editing] })} />;
  }

  const tab: InfoPageAudience = isAudience(tabParam) ? tabParam : 'customer';
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Who the policies are for" className="flex flex-wrap gap-2">
        {TABS.map((option) => (
          <button
            key={option.audience}
            type="button"
            role="tab"
            aria-selected={tab === option.audience}
            onClick={() => setParams({ tab: option.audience }, { replace: true })}
            className={`min-h-11 rounded-xl px-4 text-sm font-semibold transition ${
              tab === option.audience ? 'bg-brand-500 text-white shadow-sm' : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {INFO_PAGE_SLUGS.filter((slug) => INFO_PAGE_AUDIENCE[slug] === tab).map((slug) => (
          <PolicyCard key={slug} slug={slug} onEdit={() => setParams({ tab, edit: slug })} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* List                                                                        */
/* -------------------------------------------------------------------------- */

/** Published / Draft status of a policy, as pills. */
function StatusPills({ data }: { data: AdminInfoPageDto }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {data.published ? <Pill tone="brand">Published</Pill> : <Pill tone="gray">Not published</Pill>}
      {data.draft ? <Pill tone="amber">{data.published ? 'Draft changes' : 'Draft'}</Pill> : null}
    </span>
  );
}

function lastUpdated(data: AdminInfoPageDto): string {
  if (data.published) return data.published.lastUpdatedLabel;
  if (data.live.source === 'builtin' && data.live.lastUpdatedLabel) return `${data.live.lastUpdatedLabel} (built-in text)`;
  return '—';
}

function PolicyCard({ slug, onEdit }: { slug: InfoPageSlug; onEdit: () => void }) {
  const canEdit = useCanEdit();
  const doc = useAdminInfoPage(slug);
  return (
    <Surface className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">{INFO_PAGE_TITLES[slug]}</h2>
        {doc.data?.published ? <span className="shrink-0 text-xs text-gray-500">v{doc.data.published.version}</span> : null}
      </div>
      {doc.isPending ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : doc.isError || !doc.data ? (
        <p className="text-sm text-danger-500">{errorText(doc.error) ?? 'Could not load.'}</p>
      ) : (
        <div className="space-y-1.5 text-sm">
          <StatusPills data={doc.data} />
          <p className="text-gray-600">
            Last updated <span className="font-medium text-gray-800">{lastUpdated(doc.data)}</span>
          </p>
          {doc.data.draft ? <p className="text-xs text-gray-500">Draft saved {shortDate(doc.data.draft.updatedAt)}</p> : null}
        </div>
      )}
      <div className="mt-auto flex justify-end">
        <Button variant={canEdit ? 'soft' : 'secondary'} onClick={onEdit} aria-label={`${canEdit ? 'Edit' : 'View'} ${INFO_PAGE_TITLES[slug]}`}>
          {canEdit ? 'Edit' : 'View'}
        </Button>
      </div>
    </Surface>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

type Confirm = null | 'publish' | 'discard' | 'history' | { restore: string; revision: number };

function PolicyEditor({ slug, onBack }: { slug: InfoPageSlug; onBack: () => void }) {
  const canEdit = useCanEdit();
  const editor = useInfoPageEditor(slug);
  const { doc, content, dirty } = editor;
  const [preview, setPreview] = useState<InfoPagePreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Documents users accept (customer Privacy / Terms, Seller Terms / Privacy):
  // ask signed-in users to accept the new version (the first time always).
  const [askAcceptance, setAskAcceptance] = useState(false);
  const accepts = asksForAcceptance(slug);
  const readers = INFO_PAGE_AUDIENCE[slug] === 'seller' ? 'sellers' : 'customers';

  // Leaving with unsaved changes asks first: reloading or closing the tab, and
  // following a link inside the panel (<BrowserRouter> has no navigation
  // blocker, so link clicks are checked before the router sees them).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const guardLinks = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || link.getAttribute('target') === '_blank') return;
      if (window.confirm(LEAVE_PROMPT)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', guardLinks, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', guardLinks, true);
    };
  }, [dirty]);

  const back = () => {
    if (dirty && !window.confirm(LEAVE_PROMPT)) return;
    onBack();
  };

  const header = (
    <button type="button" onClick={back} className="text-sm font-semibold text-brand-600 hover:underline">
      ← All policies
    </button>
  );

  if (doc.isLoading) return <div className="space-y-3">{header}<Spinner /></div>;
  if (doc.isError || !doc.data) return <div className="space-y-3">{header}<ErrorBanner message={errorText(doc.error) ?? 'Could not load this policy.'} /></div>;
  const data = doc.data;

  const busy = editor.save.isPending || editor.discard.isPending || editor.publish.isPending || editor.restore.isPending;
  const actionError = errorText(editor.save.error ?? editor.discard.error ?? editor.publish.error ?? editor.restore.error);
  const unconfirmed = content ? infoPageUnconfirmed(content) : [];
  const blockers = [
    ...(unconfirmed.length > 0 ? [`replace ${unconfirmed.length} «TO CONFIRM» note${unconfirmed.length === 1 ? '' : 's'} (highlighted below)`] : []),
    ...(data.missingRequired.length > 0 && slug !== 'about' ? [`fill in Configuration: ${data.missingRequired.join(', ')}`] : []),
  ];

  // A success note for the last action; a failed action clears it (its error shows instead).
  const done = (text: string) => ({ onSuccess: () => setNotice(text), onError: () => setNotice(null) });

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
    <div className="space-y-4">
      {header}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-lg font-semibold text-gray-900">{INFO_PAGE_TITLES[slug]}</h2>
            <StatusPills data={data} />
            <p className="text-sm text-gray-600">
              {data.published ? (
                <>
                  Live: version {data.published.version} · last updated {data.published.lastUpdatedLabel}
                  {data.published.effectiveDate ? ` · takes effect ${data.published.effectiveDate}` : ''} ·{' '}
                  <a href={publicPageUrl(slug)} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 hover:underline">
                    View public page
                  </a>
                </>
              ) : data.live.source === 'builtin' ? (
                `Not published yet — ${readers} see the built-in text${data.live.lastUpdatedLabel ? ` (dated ${data.live.lastUpdatedLabel})` : ''}.`
              ) : (
                `Not published yet — ${readers} do not see this page.`
              )}
            </p>
            {data.draft ? (
              <p className="text-sm text-gray-500">
                Draft saved {dateTime(data.draft.updatedAt)}
                {data.draft.updatedBy ? ` by ${data.draft.updatedBy}` : ''} — not visible to {readers} until published.
                {canEdit ? (
                  <>
                    {' '}
                    <button type="button" className="font-semibold text-gray-600 underline hover:text-danger-500" onClick={() => setConfirm('discard')} disabled={busy}>
                      Discard draft
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              <Button variant="secondary" onClick={() => editor.save.mutate(undefined, done('Draft saved. The published policy has not changed.'))} disabled={!content || !dirty || busy}>
                {editor.save.isPending ? 'Saving…' : 'Save draft'}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void runPreview()} disabled={!content || previewing || !canEdit}>
              {previewing ? 'Preparing…' : 'Preview'}
            </Button>
            {canEdit ? (
              <Button
                onClick={() => {
                  setAskAcceptance(accepts && !data.acceptanceEverRequired);
                  setConfirm('publish');
                }}
                disabled={!data.draft || dirty || busy}
                title={dirty ? 'Save the draft first' : !data.draft ? 'Nothing new to publish' : undefined}
              >
                Publish
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setConfirm('history')}>
              Version history
            </Button>
          </div>
        </div>

        <div className="mt-3 space-y-2 empty:hidden">
          {dirty ? <p className="text-sm font-medium text-amber-700">You have unsaved changes — save the draft before publishing.</p> : null}
          {canEdit && content && blockers.length > 0 ? (
            <p className="rounded-xl bg-warn-50 px-3 py-2 text-sm text-amber-800">Before publishing: {blockers.join('; ')}.</p>
          ) : null}
          {notice && !dirty ? <p role="status" className="rounded-xl bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700">{notice}</p> : null}
          <ErrorBanner message={actionError} />
          <ErrorBanner message={previewError} />
          {!canEdit ? <p className="text-sm text-gray-500">View only — editing and publishing need Configuration write access.</p> : null}
        </div>
      </Card>

      {content ? (
        <>
          <Placeholders settings={data.settings} />
          <ContentEditor content={content} canEdit={canEdit} update={editor.update} />
        </>
      ) : (
        <Card>
          <p className="text-sm text-gray-600">This policy has no text yet.{canEdit ? ' Start from the Aadione template, edit it, then save, preview and publish.' : ''}</p>
          {canEdit ? (
            <div className="mt-3">
              <Button onClick={() => editor.replace(data.template)}>Start from the Aadione template</Button>
            </div>
          ) : null}
        </Card>
      )}

      {preview ? <PreviewModal preview={preview} onClose={() => setPreview(null)} /> : null}

      {confirm === 'history' ? (
        <VersionHistory
          slug={slug}
          data={data}
          canRestore={canEdit && !busy}
          onRestore={(id, revision) => setConfirm({ restore: id, revision })}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {confirm === 'publish' ? (
        <Modal
          title={`Publish ${INFO_PAGE_TITLES[slug]}?`}
          subtitle={`Becomes version ${data.nextVersion}, last updated today${data.draft?.content.effectiveDate ? ` · takes effect ${data.draft.content.effectiveDate} if that is later` : ''}.`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                disabled={blockers.length > 0}
                onClick={() => {
                  setConfirm(null);
                  editor.publish.mutate(accepts ? askAcceptance : undefined, done(`Published as version ${data.nextVersion}. ${readers === 'sellers' ? 'Sellers' : 'Readers'} see it within about a minute.`));
                }}
              >
                Publish now
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm text-gray-700">
            {blockers.length > 0 ? <p className="rounded-xl bg-warn-50 px-3 py-2 text-amber-800">Not yet: {blockers.join('; ')}.</p> : null}
            <p>
              The saved draft replaces the live {INFO_PAGE_TITLES[slug]} {readers === 'sellers' ? 'in the Seller Panel' : 'in the app and on the website'} within about a minute. The
              current version stays in Version history.
            </p>
            {accepts ? (
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={askAcceptance}
                  disabled={!data.acceptanceEverRequired}
                  onChange={(e) => setAskAcceptance(e.target.checked)}
                />
                <span>
                  Ask signed-in {readers} to accept this version.
                  <span className="block text-xs text-gray-500">
                    {data.acceptanceEverRequired
                      ? `Use it for significant changes; leave it off for corrections.`
                      : `The first published version is always accepted once.`}
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {confirm === 'discard' ? (
        <Modal
          title="Discard the draft?"
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => { setConfirm(null); editor.discard.mutate(undefined, done('Draft discarded.')); }}>Discard</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">The unpublished changes are deleted. The published version is not affected.</p>
        </Modal>
      ) : null}

      {confirm && typeof confirm === 'object' ? (
        <Modal
          title={`Restore version ${confirm.revision} to the draft?`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={() => { const id = confirm.restore; setConfirm(null); editor.restore.mutate(id, done(`Version ${confirm.revision} restored to the draft. Publish to make it live.`)); }}>
                Restore
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Its text becomes the draft (replacing any current draft); {readers} keep seeing the live version until you publish. Publishing it creates version{' '}
            {data.nextVersion}.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/** Business placeholders: click to copy, paste into the text; filled from Configuration when shown. */
function Placeholders({ settings }: { settings: InfoPageSettingDto[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (token: string) => {
    void navigator.clipboard?.writeText(`{{${token}}}`).then(() => setCopied(token)).catch(() => undefined);
  };
  return (
    <Surface className="px-4 py-3">
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-gray-900">
          Business details placeholders <span className="font-normal text-gray-500">— name, legal name, email, phone, address…</span>
        </summary>
      <div className="mb-2 mt-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-gray-500">Click to copy, then paste into the text. Filled in automatically when the policy is shown; a line whose value is empty is left out.</p>
        <Link to="/settings" className="text-sm font-semibold text-brand-600 hover:underline">
          Edit values in Configuration
        </Link>
      </div>
      <div className="flex flex-wrap gap-1.5">
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
            {setting.filled ? '' : ' — empty'}
            {copied === setting.token ? ' ✓ copied' : ''}
          </button>
        ))}
      </div>
      </details>
    </Surface>
  );
}

function VersionHistory({
  slug,
  data,
  canRestore,
  onRestore,
  onClose,
}: {
  slug: InfoPageSlug;
  data: AdminInfoPageDto;
  canRestore: boolean;
  onRestore: (id: string, revision: number) => void;
  onClose: () => void;
}) {
  const rows = [...(data.published ? [{ ...data.published, live: true }] : []), ...data.history.map((item) => ({ ...item, live: false }))];
  return (
    <Modal title={`Version history — ${INFO_PAGE_TITLES[slug]}`} onClose={onClose} wide>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing published yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm">
          {rows.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="min-w-0">
                <span className="font-semibold text-gray-900">Version {item.version}</span> {item.live ? <Pill tone="brand">Live</Pill> : null}
                <span className="block text-xs text-gray-500">
                  Last updated {item.lastUpdatedLabel}
                  {item.effectiveDate ? ` · takes effect ${item.effectiveDate}` : ''} · published {dateTime(item.publishedAt)}
                  {item.publishedBy ? ` by ${item.publishedBy}` : ''}
                  {item.restoredFromVersion ? ` · text of version ${item.restoredFromVersion}` : ''}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <a href={publicPageUrl(slug, item.revision)} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-brand-600 hover:underline">
                  View
                </a>
                {canRestore && !item.live ? (
                  <Button variant="secondary" onClick={() => onRestore(item.id, item.revision)}>
                    Restore to draft
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function move<T>(list: T[], index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item!);
}

const hasMarker = (text: string) => text.includes(INFO_PAGE_UNCONFIRMED_MARKER);

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
      <fieldset disabled={!canEdit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Policy title" required>
            <input className={inputClass} value={content.title} maxLength={120} onChange={(e) => update((d) => { d.title = e.target.value; })} />
          </Field>
          <Field label="Effective date (optional)" hint="Leave empty to apply from publication. Only a future date is shown.">
            <div className="flex gap-2">
              <input type="date" className={inputClass} value={content.effectiveDate} onChange={(e) => update((d) => { d.effectiveDate = e.target.value; })} />
              {content.effectiveDate ? <Button variant="ghost" onClick={() => update((d) => { d.effectiveDate = ''; })}>Clear</Button> : null}
            </div>
          </Field>
        </div>

        {content.sections.map((section, s) => (
          <section key={s} className="rounded-2xl border border-gray-200 p-3 sm:p-4" aria-label={`Section ${s + 1}`}>
            <div className="flex flex-wrap items-end gap-1">
              <div className="min-w-[12rem] flex-1">
                <Field label={`Section ${s + 1} heading`} required>
                  <input
                    className={`${inputClass} ${hasMarker(section.heading) ? 'ring-2 ring-amber-300' : ''}`}
                    value={section.heading}
                    maxLength={160}
                    onChange={(e) => update((d) => { d.sections[s]!.heading = e.target.value; })}
                  />
                </Field>
              </div>
              <Button variant="ghost" onClick={() => update((d) => move(d.sections, s, -1))} disabled={s === 0} aria-label={`Move section ${s + 1} up`}>↑</Button>
              <Button variant="ghost" onClick={() => update((d) => move(d.sections, s, 1))} disabled={s === content.sections.length - 1} aria-label={`Move section ${s + 1} down`}>↓</Button>
              <Button variant="ghost" onClick={() => update((d) => { d.sections.splice(s, 1); })} aria-label={`Remove section ${s + 1}`}>Remove</Button>
            </div>
            <div className="mt-3 space-y-2">
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
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="soft" onClick={() => update((d) => { d.sections[s]!.blocks.push({ type: 'paragraph', text: '' }); })}>+ Paragraph</Button>
                  <Button variant="soft" onClick={() => update((d) => { d.sections[s]!.blocks.push({ type: 'bullets', items: [''] }); })}>+ Bullet list</Button>
                </div>
              ) : null}
            </div>
          </section>
        ))}
        {canEdit ? (
          <Button variant="soft" onClick={() => update((d) => { d.sections.push({ heading: '', blocks: [{ type: 'paragraph', text: '' }] }); })}>+ Add section</Button>
        ) : null}
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
    <div className={`rounded-xl bg-gray-50 p-2.5 ${hasMarker(value) ? 'ring-2 ring-amber-300' : ''}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1 text-xs">
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
        <Button variant="ghost" onClick={() => onMove(-1)} disabled={first} aria-label="Move up">↑</Button>
        <Button variant="ghost" onClick={() => onMove(1)} disabled={last} aria-label="Move down">↓</Button>
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
      subtitle={`As readers would see it if published now (version ${preview.onPublish.version}, last updated ${preview.onPublish.lastUpdatedLabel}${preview.onPublish.effectiveLabel ? `, takes effect ${preview.onPublish.effectiveLabel}` : ''}). Not public.`}
      onClose={onClose}
      wide
    >
      <div className="space-y-3">
        {page.missing.length > 0 ? <p className="text-xs text-gray-500">Lines using these empty settings are hidden: {page.missing.join(', ')}.</p> : null}
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

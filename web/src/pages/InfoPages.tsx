/**
 * Legal & Policies — a small CMS for the customer Privacy Policy, Terms,
 * Refund & Cancellation, Shipping & Delivery and Cookie policies, the Seller
 * Terms and Seller Privacy Policy, and About Aadione.
 *
 * Two views (both in the URL, so a refresh or Back keeps your place):
 *   - the list: Customers / Sellers / Everyone tabs, one card per policy with
 *     its status, last-updated date and Edit;
 *   - the editor (?edit=<slug>): the policy's title and ONE document to type
 *     into, like a word processor (components/PolicyDocumentEditor.tsx):
 *     Heading 1 starts a section, Heading 2 / 3 are sub-headings, with bold,
 *     italic, underline, bullet and numbered lists, links, undo / redo.
 *     Save draft, Preview and Publish sit at the top; the "takes effect"
 *     date, business-detail placeholders, version history and discarding
 *     the draft are folded into Advanced settings.
 *
 * Same server and storage as before (lib/infoPages.ts;
 * content/info-page.service.ts): the document is converted to the shared
 * structured page (lib/policyDocument.ts) — text and formatted pieces, never
 * HTML — and checked exactly as the server checks it before saving, with any
 * problem said in plain words. Customers — in the app, on the website and at
 * the public link — only ever see the published version; a draft never
 * changes it, publishing asks for confirmation, and every earlier version
 * stays in the history. Version and "Last updated" are set by the server.
 *
 * Business and contact details are {{SETTING}} placeholders filled from
 * Configuration each time the page is shown (a line whose setting is empty is
 * left out). The server still refuses to publish a page with a «TO CONFIRM»
 * note or a required setting empty; the editor highlights the notes and says
 * so in one line next to Publish.
 *
 * Reading needs Configuration access; editing and publishing need
 * Configuration write access (the server enforces both).
 */

import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  INFO_PAGE_AUDIENCE,
  INFO_PAGE_LIMITS,
  INFO_PAGE_SLUGS,
  INFO_PAGE_TITLES,
  Permission,
  asksForAcceptance,
  infoPageUnconfirmed,
  infoRichSegments,
  roleHasPermission,
  type AdminInfoPageDto,
  type InfoPageAudience,
  type InfoPageBlock,
  type InfoPageContent,
  type InfoPagePreviewDto,
  type InfoPageSettingDto,
  type InfoPageSlug,
  type InfoTextRun,
} from '@shared';
import { Button, Card, ErrorBanner, Field, Modal, Pill, Spinner, Surface, inputClass } from '@/components/ui';
import type { PolicyEditorHandle } from '@/components/PolicyDocumentEditor';
import { useAuth } from '@/lib/auth';
import { apiAbsoluteUrl } from '@/lib/api';
import { previewInfoPage, useAdminInfoPage, useInfoPageEditor } from '@/lib/infoPages';
import { confirmLeave, useUnsavedChangesGuard } from '@/lib/unsavedChanges';
import { BLANK_DOC, checkPolicy, contentToDoc, docToContent, samePage, type DocNode, type PolicyCheck, type PolicyMeta } from '@/lib/policyDocument';

/** The document editor is downloaded only when a policy is opened. */
const PolicyDocumentEditor = lazy(() => import('@/components/PolicyDocumentEditor'));

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
/** Keys that move around or select without changing the text (they do not arm the leave guard). */
const NON_EDITING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape', 'Tab', 'F5', 'F12']);

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

/** The page's settings besides its text (title, "takes effect" date, and what the server keeps on it). */
const metaOf = (content: InfoPageContent): PolicyMeta => {
  const { sections: _sections, ...meta } = content;
  return meta;
};

function PolicyEditor({ slug, onBack }: { slug: InfoPageSlug; onBack: () => void }) {
  const canEdit = useCanEdit();
  const editor = useInfoPageEditor(slug);
  const { doc, serverContent } = editor;
  const documentRef = useRef<PolicyEditorHandle>(null);

  // What the document editor shows (null: this policy has no text yet), and a
  // counter that makes it show `initialDoc` again (restore, discard, publish).
  const [initialDoc, setInitialDoc] = useState<DocNode | null>(() => (serverContent ? contentToDoc(serverContent) : null));
  const [resetKey, setResetKey] = useState(0);
  const [meta, setMeta] = useState<PolicyMeta>(() => (serverContent ? metaOf(serverContent) : { title: INFO_PAGE_TITLES[slug], effectiveDate: '' }));
  const metaRef = useRef(meta);
  metaRef.current = meta;

  // Unsaved edits = the editor's page differs from `baseline` (the page last
  // loaded or saved). Compared as pages, not counted as keystrokes: the
  // editor's own tidying (e.g. the empty line it keeps after a final list) is
  // not a change, and undoing back to the saved text is not unsaved. The ref
  // is read by effects and callbacks; `edits` counts changes, so a save that
  // finishes after more typing leaves the page marked unsaved.
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const edits = useRef(0);
  const baseline = useRef<InfoPageContent | null>(serverContent);
  const setDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirtyState(value);
  };

  /** The editor's page as it is now, checked like the server checks it. */
  const currentCheck = useCallback((): PolicyCheck | null => {
    const now = documentRef.current?.getDoc() ?? initialDoc;
    return now ? checkPolicy(now, metaRef.current) : null;
  }, [initialDoc]);
  const currentContent = useCallback((): InfoPageContent | null => {
    const now = documentRef.current?.getDoc() ?? initialDoc;
    return now ? docToContent(now, metaRef.current) : null;
  }, [initialDoc]);

  // «TO CONFIRM» notes still in the text, and — once saving was refused — what is
  // still wrong, both kept up to date while typing (shortly after each pause).
  const [unconfirmed, setUnconfirmed] = useState(0);
  const [problems, setProblems] = useState<string[] | null>(null);
  const problemsShown = useRef(false);
  problemsShown.current = problems !== null;
  // Leaving with unsaved changes asks first — reload / tab close, links,
  // browser Back and Forward, Sign out, notifications (lib/unsavedChanges.ts).
  // The guard is armed on the first real edit (typing, paste, toolbar, a
  // settings field — see onEditorInput), not by the editor's own tidying on open.
  const { arm: armLeaveGuard } = useUnsavedChangesGuard({ dirty, isDirty: () => dirtyRef.current, message: LEAVE_PROMPT });

  const timer = useRef<number | undefined>(undefined);
  const refreshChecks = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const content = currentContent();
      const changedNow = !samePage(content, baseline.current);
      dirtyRef.current = changedNow;
      setDirtyState(changedNow);
      // Any change not caught as input (e.g. a placeholder inserted from Advanced settings).
      if (changedNow) armLeaveGuard();
      setUnconfirmed(content ? infoPageUnconfirmed(content).length : 0);
      if (problemsShown.current) {
        const check = currentCheck();
        setProblems(check && !check.ok ? check.problems : null);
      }
    }, 350);
  }, [currentCheck, currentContent, armLeaveGuard]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const changed = useCallback(() => {
    edits.current += 1;
    // Guard leaving at once; whether anything really changed is settled after the pause.
    dirtyRef.current = true;
    refreshChecks();
  }, [refreshChecks]);

  /** The admin's own input in the document (keys that edit, paste, cut, drop, toolbar): arm the Back / Forward guard at once. */
  const onEditorInput = (event: { type: string; key?: string; ctrlKey?: boolean; metaKey?: boolean; target: EventTarget }) => {
    if (!canEdit) return;
    if (event.type === 'keydown' && !event.ctrlKey && !event.metaKey && event.key && NON_EDITING_KEYS.has(event.key)) return;
    if (event.type === 'click' && !(event.target instanceof Element && event.target.closest('[role=toolbar] button, [role=toolbar] select'))) return;
    armLeaveGuard();
  };

  // The server's page changed (loaded, saved, published, restored, discarded).
  // Unsaved typing is never replaced; the page just saved from this editor is
  // not reloaded either (the cursor and undo history stay).
  useEffect(() => {
    if (dirtyRef.current) return;
    baseline.current = serverContent;
    if (!serverContent) {
      setInitialDoc(null);
      return;
    }
    const now = documentRef.current ? docToContent(documentRef.current.getDoc(), metaRef.current) : null;
    if (now && samePage(now, serverContent)) return;
    setMeta(metaOf(serverContent));
    setInitialDoc(contentToDoc(serverContent));
    setResetKey((key) => key + 1);
    setProblems(null);
    setUnconfirmed(infoPageUnconfirmed(serverContent).length);
  }, [serverContent]);

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

  const back = () => {
    if (!confirmLeave()) return;
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
  const blockers = [
    ...(unconfirmed > 0 ? [`replace ${unconfirmed} «TO CONFIRM» note${unconfirmed === 1 ? '' : 's'} (highlighted in yellow)`] : []),
    ...(data.missingRequired.length > 0 && slug !== 'about' ? [`fill in Configuration: ${data.missingRequired.join(', ')}`] : []),
  ];

  // A success note for the last action; a failed action clears it (its error shows instead).
  const done = (text: string) => ({ onSuccess: () => setNotice(text), onError: () => setNotice(null) });

  /** The page to save or preview, or null after showing what to fix first. */
  function checkedForSending(): InfoPageContent | null {
    const check = currentCheck();
    if (!check) return null;
    if (!check.ok) {
      setProblems(check.problems);
      setNotice(null);
      return null;
    }
    setProblems(null);
    return check.content;
  }

  function saveDraft() {
    const content = checkedForSending();
    if (!content) return;
    const sentAt = edits.current;
    editor.save.mutate(content, {
      onSuccess: () => {
        baseline.current = content;
        // Typing during the save keeps the page unsaved.
        if (edits.current === sentAt) setDirty(false);
        setNotice('Draft saved. The published policy has not changed.');
      },
      onError: () => setNotice(null),
    });
  }

  async function runPreview() {
    const content = checkedForSending();
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

  /** Starts a policy that has no text yet (still unsaved). */
  function start(content: InfoPageContent | null) {
    setMeta(content ? metaOf(content) : { title: INFO_PAGE_TITLES[slug], effectiveDate: '' });
    setInitialDoc(content ? contentToDoc(content) : BLANK_DOC);
    setUnconfirmed(content ? infoPageUnconfirmed(content).length : 0);
    // Nothing is saved yet, so the new page is an unsaved change.
    baseline.current = null;
    edits.current += 1;
    setDirty(true);
    armLeaveGuard();
  }

  const updateMeta = (change: Partial<PolicyMeta>) => {
    setMeta((current) => ({ ...current, ...change }));
    armLeaveGuard(); // the title or "takes effect" date: a real edit
    changed();
  };

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
                  {data.published.effectiveDate ? ` · takes effect ${data.published.effectiveDate}` : ''}
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
              </p>
            ) : null}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {canEdit ? (
              <Button variant="secondary" onClick={saveDraft} disabled={!initialDoc || !dirty || busy}>
                {editor.save.isPending ? 'Saving…' : 'Save draft'}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void runPreview()} disabled={!initialDoc || previewing || !canEdit}>
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
          </div>
        </div>

        <div className="mt-3 space-y-2 empty:hidden">
          {dirty ? <p className="text-sm font-medium text-amber-700">You have unsaved changes — save the draft before publishing.</p> : null}
          {canEdit && initialDoc && blockers.length > 0 ? (
            <p className="rounded-xl bg-warn-50 px-3 py-2 text-sm text-amber-800">Before publishing: {blockers.join('; ')}.</p>
          ) : null}
          {problems && problems.length > 0 ? (
            <div role="alert" className="rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-600">
              <p className="font-semibold">Fix {problems.length === 1 ? 'this' : 'these'} first:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {notice && !dirty ? <p role="status" className="rounded-xl bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700">{notice}</p> : null}
          <ErrorBanner message={actionError} />
          <ErrorBanner message={previewError} />
          {!canEdit ? <p className="text-sm text-gray-500">View only — editing and publishing need Configuration write access.</p> : null}
        </div>
      </Card>

      {initialDoc ? (
        <Surface className="px-4 pt-4 sm:px-6 sm:pt-6">
          <label htmlFor="policy-title" className="sr-only">
            Policy title
          </label>
          <input
            id="policy-title"
            value={meta.title}
            readOnly={!canEdit}
            maxLength={INFO_PAGE_LIMITS.title}
            placeholder="Policy title"
            onChange={(event) => updateMeta({ title: event.target.value })}
            className="w-full border-0 bg-transparent p-0 text-xl font-bold text-gray-900 placeholder:text-gray-300 focus:outline-none focus:ring-0 sm:text-3xl"
          />
          {canEdit ? (
            <p className="mt-1 text-xs text-gray-500">
              Type as in a normal document. Start each part with <span className="font-semibold">Heading 1</span> — it becomes a section in the
              policy&apos;s contents.
            </p>
          ) : null}
          <Suspense fallback={<div className="py-10"><Spinner label="Opening the editor…" /></div>}>
            <div
              className="mt-2"
              onKeyDownCapture={onEditorInput}
              onPasteCapture={onEditorInput}
              onCutCapture={onEditorInput}
              onDropCapture={onEditorInput}
              onClickCapture={onEditorInput}
              onChangeCapture={onEditorInput}
            >
              <PolicyDocumentEditor ref={documentRef} initialDoc={initialDoc} resetKey={resetKey} editable={canEdit} onChange={changed} />
            </div>
          </Suspense>
        </Surface>
      ) : (
        <Card>
          <p className="text-sm text-gray-600">This policy has no text yet.{canEdit ? ' Start from the Aadione template or a blank page, then save, preview and publish.' : ''}</p>
          {canEdit ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => start(data.template)}>Start from the Aadione template</Button>
              <Button variant="secondary" onClick={() => start(null)}>Start with a blank page</Button>
            </div>
          ) : null}
        </Card>
      )}

      <AdvancedSettings
        slug={slug}
        data={data}
        canEdit={canEdit}
        busy={busy}
        effectiveDate={meta.effectiveDate}
        onEffectiveDate={initialDoc ? (effectiveDate) => updateMeta({ effectiveDate }) : null}
        onInsert={initialDoc && canEdit ? (token) => documentRef.current?.insertText(`{{${token}}}`) : null}
        onHistory={() => setConfirm('history')}
        onDiscard={() => setConfirm('discard')}
      />

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
              <Button
                variant="danger"
                onClick={() => {
                  setConfirm(null);
                  // The editor then shows the published policy again.
                  setDirty(false);
                  editor.discard.mutate(undefined, done('Draft discarded.'));
                }}
              >
                Discard
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">The unpublished changes (saved and unsaved) are deleted. The published version is not affected.</p>
        </Modal>
      ) : null}

      {confirm && typeof confirm === 'object' ? (
        <Modal
          title={`Restore version ${confirm.revision} to the draft?`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                onClick={() => {
                  const id = confirm.restore;
                  setConfirm(null);
                  setDirty(false);
                  editor.restore.mutate(id, done(`Version ${confirm.revision} restored to the draft. Publish to make it live.`));
                }}
              >
                Restore
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Its text becomes the draft (replacing any current draft{dirty ? ' and your unsaved changes' : ''}); {readers} keep seeing the live version until you publish.
            Publishing it creates version {data.nextVersion}.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Less-used settings, folded away: the "takes effect" date, business-detail
 * placeholders, version history, the public link and discarding the draft.
 */
function AdvancedSettings({
  slug,
  data,
  canEdit,
  busy,
  effectiveDate,
  onEffectiveDate,
  onInsert,
  onHistory,
  onDiscard,
}: {
  slug: InfoPageSlug;
  data: AdminInfoPageDto;
  canEdit: boolean;
  busy: boolean;
  effectiveDate: string;
  onEffectiveDate: ((value: string) => void) | null;
  onInsert: ((token: string) => void) | null;
  onHistory: () => void;
  onDiscard: () => void;
}) {
  const versions = (data.published ? 1 : 0) + data.history.length;
  return (
    <Surface className="px-4 py-3">
      <details>
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-gray-900">
          Advanced settings
          <span className="ml-2 font-normal text-gray-500">— effective date, business details, version history</span>
        </summary>
        <div className="space-y-5 pb-2 pt-3">
          {onEffectiveDate ? (
            <div className="max-w-sm">
              <Field label="Takes effect on (optional)" hint="Leave empty to apply from publication. Only a future date is shown to readers.">
                <div className="flex gap-2">
                  <input
                    type="date"
                    className={inputClass}
                    value={effectiveDate}
                    disabled={!canEdit}
                    onChange={(event) => onEffectiveDate(event.target.value)}
                  />
                  {effectiveDate && canEdit ? <Button variant="ghost" onClick={() => onEffectiveDate('')}>Clear</Button> : null}
                </div>
              </Field>
            </div>
          ) : null}

          <Placeholders settings={data.settings} onInsert={onInsert} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <Button variant="secondary" onClick={onHistory}>
              Version history{versions > 0 ? ` (${versions})` : ''}
            </Button>
            {data.published ? (
              <a href={publicPageUrl(slug)} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-600 hover:underline">
                View public page
              </a>
            ) : null}
            {canEdit && data.draft ? (
              <button type="button" className="font-semibold text-gray-600 underline hover:text-danger-500" onClick={onDiscard} disabled={busy}>
                Discard draft
              </button>
            ) : null}
          </div>
        </div>
      </details>
    </Surface>
  );
}

/** Business placeholders: inserted at the cursor, filled from Configuration each time the policy is shown. */
function Placeholders({ settings, onInsert }: { settings: InfoPageSettingDto[]; onInsert: ((token: string) => void) | null }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-gray-700">Business details</p>
          <p className="text-xs text-gray-500">
            {onInsert ? 'Click one to insert it where the cursor is in the text. ' : ''}
            Filled in automatically when the policy is shown; a line whose value is empty is left out.
          </p>
        </div>
        <Link to="/settings" className="text-sm font-semibold text-brand-600 hover:underline">
          Edit values in Configuration
        </Link>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {settings.map((setting) => (
          <button
            key={setting.token}
            type="button"
            disabled={!onInsert}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onInsert?.(setting.token)}
            title={`Inserts {{${setting.token}}}`}
            className={`rounded-lg border px-2.5 py-1.5 text-xs disabled:cursor-default ${
              setting.filled ? 'border-brand-200 bg-brand-50 text-brand-700' : setting.required ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-200 bg-gray-50 text-gray-500'
            }`}
          >
            {setting.label}
            {setting.filled ? '' : ' — empty'}
          </button>
        ))}
      </div>
    </div>
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

/** Wording with its bold / italic / underline, links and line breaks (text only — React escapes it). */
function RichText({ text, runs }: { text: string; runs?: InfoTextRun[] }) {
  return (
    <>
      {infoRichSegments(text, runs).map((segment, i) => {
        let node: ReactNode = segment.text.split('\n').flatMap((line, l) => (l === 0 ? [line] : [<br key={l} />, line]));
        if (segment.underline) node = <u>{node}</u>;
        if (segment.italic) node = <em>{node}</em>;
        if (segment.bold) node = <strong>{node}</strong>;
        return segment.href ? (
          <a key={i} href={segment.href} target="_blank" rel="noopener noreferrer">
            {node}
          </a>
        ) : (
          <Fragment key={i}>{node}</Fragment>
        );
      })}
    </>
  );
}

function PreviewBlock({ block }: { block: InfoPageBlock }) {
  switch (block.type) {
    case 'paragraph':
      return <p><RichText text={block.text} runs={block.runs} /></p>;
    case 'subheading':
      return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
    case 'bullets':
    case 'numbered': {
      const items = block.items.map((item, i) => <li key={i}><RichText text={item} runs={block.itemRuns?.[i]} /></li>);
      return block.type === 'numbered' ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
  }
}

function PreviewModal({ preview, onClose }: { preview: InfoPagePreviewDto; onClose: () => void }) {
  const { page } = preview;
  return (
    <Modal
      title={`Preview — ${page.title}`}
      subtitle={`As readers would see it if published now (version ${preview.onPublish.version}, last updated ${preview.onPublish.lastUpdatedLabel}${preview.onPublish.effectiveLabel ? `, takes effect ${preview.onPublish.effectiveLabel}` : ''}). Business details are filled from Configuration. Not public.`}
      onClose={onClose}
      wide
    >
      <div className="space-y-3">
        {page.missing.length > 0 ? <p className="text-xs text-gray-500">Lines using these empty settings are hidden: {page.missing.join(', ')}.</p> : null}
        <article className="policy-doc policy-preview min-h-0 rounded-2xl border border-gray-200 px-5 py-5">
          {page.sections.map((section, s) => (
            <section key={s}>
              <h1>{section.heading}</h1>
              {section.blocks.map((block, b) => (
                <div key={b} className="mt-3">
                  <PreviewBlock block={block} />
                </div>
              ))}
            </section>
          ))}
        </article>
      </div>
    </Modal>
  );
}

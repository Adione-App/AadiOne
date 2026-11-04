/**
 * Information Pages — Privacy Policy, Terms & Conditions, About Aadione.
 *
 * Edit → Save draft → Preview → Publish, with version history and restore
 * (lib/infoPages.ts; server: content/info-page.service.ts). Customers only
 * ever see the published page.
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
  INFO_PAGE_UNCONFIRMED_MARKER,
  Permission,
  roleHasPermission,
  type InfoPageBlock,
  type InfoPageContent,
  type InfoPagePreviewDto,
  type InfoPageSlug,
} from '@shared';
import { Button, Card, ErrorBanner, Field, Modal, Panel, Pill, Spinner, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { previewInfoPage, useInfoPageEditor } from '@/lib/infoPages';

const errorText = (error: unknown): string | null => (error instanceof Error ? error.message : error ? 'Something went wrong.' : null);
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const UNPUBLISHED_NOTE: Record<InfoPageSlug, string> = {
  privacy: 'Not published yet — customers see the built-in privacy wording until you publish.',
  terms: 'Not published yet — customers see the built-in terms until you publish.',
  about: 'Not published yet — the app shows its own About screen until you publish.',
};

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

  if (doc.isLoading) return <Spinner />;
  if (doc.isError || !doc.data) return <ErrorBanner message={errorText(doc.error) ?? 'Could not load this page.'} />;
  const data = doc.data;

  const busy = editor.save.isPending || editor.discard.isPending || editor.publish.isPending || editor.restore.isPending;
  const actionError = errorText(editor.save.error ?? editor.discard.error ?? editor.publish.error ?? editor.restore.error);
  const unconfirmedCount = content ? JSON.stringify(content).split(INFO_PAGE_UNCONFIRMED_MARKER).length - 1 : 0;
  const missingRequired = data.settings.filter((setting) => setting.required && !setting.filled);

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
          <div className="space-y-1 text-sm">
            {data.published ? (
              <p>
                <Pill tone="brand">Published</Pill>{' '}
                <span className="font-semibold">
                  Version {data.published.version} · effective {data.published.effectiveDate}
                </span>{' '}
                <span className="text-gray-500">
                  (revision {data.published.revision}, {dateTime(data.published.publishedAt)}
                  {data.published.publishedBy ? ` by ${data.published.publishedBy}` : ''})
                </span>
              </p>
            ) : (
              <p>
                <Pill tone="amber">Not published</Pill> <span className="text-gray-600">{UNPUBLISHED_NOTE[slug]}</span>
              </p>
            )}
            {data.draft ? (
              <p className="text-gray-600">
                Draft saved {dateTime(data.draft.updatedAt)}
                {data.draft.updatedBy ? ` by ${data.draft.updatedBy}` : ''} — not visible to customers until published.
              </p>
            ) : null}
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
              <Button onClick={() => setConfirm('publish')} disabled={!data.draft || dirty || busy}>
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

      <SettingsPanel slug={slug} settings={data.settings} missingRequired={missingRequired.map((setting) => setting.label)} />

      {content ? (
        <ContentEditor content={content} canEdit={canEdit} update={editor.update} unconfirmedCount={unconfirmedCount} />
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
                  <span className="font-semibold">Version {item.version}</span> · effective {item.effectiveDate}{' '}
                  <span className="text-gray-500">
                    (revision {item.revision}, published {dateTime(item.publishedAt)}
                    {item.publishedBy ? ` by ${item.publishedBy}` : ''})
                  </span>
                </span>
                {canEdit ? (
                  <Button variant="secondary" onClick={() => setConfirm({ restore: item.id, revision: item.revision })} disabled={busy}>
                    Restore to draft
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
          subtitle={data.draft ? `Version ${data.draft.content.version}, effective ${data.draft.content.effectiveDate}` : undefined}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={() => { setConfirm(null); editor.publish.mutate(); }}>Publish now</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Customers see the published version immediately in the app and at the public page link. Make sure the wording has been reviewed (and, for the
            Privacy Policy and Terms, approved by your legal adviser).
          </p>
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
          title={`Restore revision ${confirm.revision} to the draft?`}
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={() => { const id = confirm.restore; setConfirm(null); editor.restore.mutate(id); }}>Restore</Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">That version becomes the draft. Customers keep seeing the current version until you publish.</p>
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

function ContentEditor({
  content,
  canEdit,
  update,
  unconfirmedCount,
}: {
  content: InfoPageContent;
  canEdit: boolean;
  update: (change: (draft: InfoPageContent) => void) => void;
  unconfirmedCount: number;
}) {
  return (
    <Card>
      <fieldset disabled={!canEdit} className="space-y-5">
        {unconfirmedCount > 0 ? (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {unconfirmedCount} «TO CONFIRM» note{unconfirmedCount === 1 ? '' : 's'} left — replace each with the final wording. A page with any left cannot be published.
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Title" required>
            <input className={inputClass} value={content.title} maxLength={120} onChange={(e) => update((d) => { d.title = e.target.value; })} />
          </Field>
          <Field label="Version" required hint="e.g. 2.0 — raise it for every change you publish">
            <input className={inputClass} value={content.version} maxLength={20} onChange={(e) => update((d) => { d.version = e.target.value; })} />
          </Field>
          <Field label="Effective date" required>
            <input type="date" className={inputClass} value={content.effectiveDate} onChange={(e) => update((d) => { d.effectiveDate = e.target.value; })} />
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
    <Modal title={`Preview — ${page.title}`} subtitle={`Version ${page.version} · effective ${page.effectiveDate} · with today's settings`} onClose={onClose} wide>
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

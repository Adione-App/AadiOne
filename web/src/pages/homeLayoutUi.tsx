/**
 * Pieces shared by the Home Page Builder and Category Management pages: the
 * colour picker (named colours or #RRGGBB — never free CSS), the
 * draft/publish bar and its version history.
 */

import { useState, type ReactNode } from 'react';
import { CONTENT_COLOR_PRESETS, CONTENT_COLOR_PRESET_LABELS, HEX_COLOR_PATTERN, contentColor, type ContentColorPreset } from '@shared';
import { Button, Icon, Modal, Pill, inputClass } from '@/components/ui';
import { adminErrorMessage } from '@/lib/marketplace';
import type { LayoutEditor } from '@/lib/homeLayout';

export type Notice = { ok: boolean; text: string } | null;

export function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role="status" className={`rounded-xl px-3.5 py-2.5 text-sm font-medium ${notice.ok ? 'bg-brand-50 text-brand-700' : 'bg-danger-50 text-danger-600'}`}>
      {notice.text}
    </p>
  );
}

const PRESETS = Object.keys(CONTENT_COLOR_PRESETS) as ContentColorPreset[];

/** A named colour from the list, or "Custom" with a #RRGGBB code. */
export function ColorPicker({
  value,
  onChange,
  allowNone = true,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  allowNone?: boolean;
  label: string;
}) {
  const isPreset = value in CONTENT_COLOR_PRESETS;
  const [custom, setCustom] = useState(isPreset ? '' : value);
  const options = allowNone ? PRESETS : PRESETS.filter((preset) => preset !== 'none');
  const customValid = HEX_COLOR_PATTERN.test(custom);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="h-7 w-7 shrink-0 rounded-lg border border-gray-300" style={{ background: contentColor(value) }} aria-hidden />
      <select
        aria-label={label}
        className={`${inputClass} w-auto`}
        value={isPreset ? value : 'custom'}
        onChange={(event) => {
          if (event.target.value === 'custom') onChange(customValid ? custom : '#FFFFFF');
          else onChange(event.target.value);
        }}
      >
        {options.map((preset) => (
          <option key={preset} value={preset}>
            {CONTENT_COLOR_PRESET_LABELS[preset]}
          </option>
        ))}
        <option value="custom">Custom colour…</option>
      </select>
      {!isPreset && (
        <input
          aria-label={`${label} — colour code`}
          className={`${inputClass} w-28 font-mono ${HEX_COLOR_PATTERN.test(custom || value) ? '' : 'border-danger-500'}`}
          value={custom || value}
          placeholder="#FFE7D1"
          maxLength={7}
          onChange={(event) => {
            const next = event.target.value.trim();
            setCustom(next);
            if (HEX_COLOR_PATTERN.test(next)) onChange(next.toUpperCase());
          }}
        />
      )}
    </div>
  );
}

/** "Draft — not live" / "Live, revision 3" and the Save / Discard / Publish / History actions. */
export function PublishBar({ editor, canEdit, onNotice, preview }: { editor: LayoutEditor; canEdit: boolean; onNotice: (notice: Notice) => void; preview?: ReactNode }) {
  const { doc, dirty, save, discard, publish, restore } = editor;
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState(false);
  const data = doc.data;
  const busy = save.isPending || discard.isPending || publish.isPending || restore.isPending;

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      onNotice({ ok: true, text: label });
    } catch (error) {
      onNotice({ ok: false, text: adminErrorMessage(error) });
    }
  };

  const status = dirty ? (
    <Pill tone="amber">Unsaved changes</Pill>
  ) : data?.draft ? (
    <Pill tone="amber">Draft saved — not live yet</Pill>
  ) : data?.published ? (
    <Pill tone="brand">Live — no unpublished changes</Pill>
  ) : (
    <Pill tone="gray">Using the built-in defaults</Pill>
  );

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
      <div className="mr-auto flex flex-wrap items-center gap-2 text-sm text-gray-600">
        {status}
        <span>
          {data?.published
            ? `Live: version ${data.published.revision}${data.published.publishedAt ? `, ${new Date(data.published.publishedAt).toLocaleString()}` : ''}${data.published.publishedBy ? ` by ${data.published.publishedBy}` : ''}`
            : 'Nothing published yet'}
        </span>
      </div>
      {preview}
      {data && (data.history.length > 0 || data.published) && (
        <Button variant="ghost" onClick={() => setHistory(true)}>
          <Icon name="clock" className="h-4 w-4" /> History
        </Button>
      )}
      {canEdit && (
        <>
          <Button variant="secondary" disabled={busy || (!dirty && !data?.draft)} onClick={() => run('Unpublished changes discarded.', () => discard.mutateAsync())}>
            Discard draft
          </Button>
          <Button variant="secondary" disabled={busy || !dirty} onClick={() => run('Draft saved. Customers do not see it until you publish.', () => save.mutateAsync())}>
            Save draft
          </Button>
          <Button disabled={busy || (!dirty && !data?.draft)} onClick={() => setConfirming(true)}>
            Publish
          </Button>
        </>
      )}

      {confirming && (
        <Modal
          title="Publish these changes?"
          subtitle="Customers see the new Home page on their next refresh — no app update needed."
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run('Published. Customers see it on their next refresh.', async () => {
                    if (dirty) await save.mutateAsync();
                    await publish.mutateAsync();
                  }).finally(() => setConfirming(false))
                }
              >
                Publish now
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">
            Every section, category and image reference is checked first. If something no longer exists (for example a category a seller
            removed), nothing is published and you are told what to fix. The current live version stays in History and can be restored.
          </p>
        </Modal>
      )}

      {history && data && (
        <Modal title="Version history" subtitle="Restoring copies a version into the draft; publish it to make it live." onClose={() => setHistory(false)}>
          <ul className="divide-y divide-gray-100 text-sm">
            {[...(data.published ? [{ ...data.published, live: true }] : []), ...data.history.map((entry) => ({ ...entry, live: false }))].map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <span className="font-semibold text-gray-900">Version {entry.revision}</span>
                {entry.live && <Pill tone="brand">Live</Pill>}
                <span className="text-gray-500">
                  {entry.publishedAt ? new Date(entry.publishedAt).toLocaleString() : ''}
                  {entry.publishedBy ? ` · ${entry.publishedBy}` : ''}
                </span>
                {canEdit && !entry.live && (
                  <Button
                    variant="soft"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() =>
                      void run(`Version ${entry.revision} copied into the draft. Publish to make it live.`, () => restore.mutateAsync(entry.id)).finally(() =>
                        setHistory(false),
                      )
                    }
                  >
                    Restore into draft
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

/** ↑ / ↓ reorder buttons, as on the Banners page. */
export function MoveButtons({ index, count, onMove, label, disabled }: { index: number; count: number; onMove: (to: number) => void; label: string; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      {(['up', 'down'] as const).map((direction) => {
        const target = direction === 'up' ? index - 1 : index + 1;
        return (
          <button
            key={direction}
            type="button"
            disabled={disabled || target < 0 || target >= count}
            onClick={() => onMove(target)}
            className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-30"
            aria-label={`Move ${label} ${direction}`}
          >
            {direction === 'up' ? '↑' : '↓'}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Drag-and-drop reordering for a list (sections, chosen products or
 * categories). The handle starts the drag — so inputs inside a row stay
 * usable — and the row it is dropped on takes its place. The ↑ / ↓ buttons
 * (MoveButtons) remain the keyboard-accessible way to do the same.
 */
export function useDragReorder(onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const reset = () => {
    setDragging(null);
    setOver(null);
  };
  return {
    dragging,
    over,
    handleProps: (index: number) => ({
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        setDragging(index);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      },
      onDragEnd: reset,
    }),
    dropProps: (index: number) => ({
      onDragOver: (event: React.DragEvent) => {
        if (dragging === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (over !== index) setOver(index);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        if (dragging !== null && dragging !== index) onMove(dragging, index);
        reset();
      },
    }),
  };
}

/** The drag handle drawn on a reorderable row. */
export function DragHandle({ label, ...props }: { label: string } & React.HTMLAttributes<HTMLSpanElement> & { draggable?: boolean }) {
  return (
    <span {...props} title={`Drag to move ${label}`} aria-hidden className="cursor-grab select-none px-1 text-lg leading-none text-gray-400 hover:text-gray-600 active:cursor-grabbing">
      ⋮⋮
    </span>
  );
}

/** Moves item `from` to `to` in a copy of the array. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** CSS for a hero background in the phone preview (same rules as the app). */
export function backgroundCss(background: { type: string; color: string; colorTo: string; direction: string; imageUrl: string | null; overlayColor: string; overlayOpacity: number }, imageSrc: (url: string) => string | undefined): React.CSSProperties {
  const angle = background.direction === 'horizontal' ? '90deg' : background.direction === 'diagonal' ? '135deg' : '180deg';
  if (background.type === 'solid') return { background: contentColor(background.color, '#FFFFFF') };
  if (background.type === 'image' && background.imageUrl) {
    const overlay = contentColor(background.overlayColor, '#FFFFFF');
    const alpha = Math.round(background.overlayOpacity * 255).toString(16).padStart(2, '0');
    return {
      backgroundImage: `linear-gradient(${overlay}${alpha}, ${overlay}${alpha}), url("${imageSrc(background.imageUrl) ?? ""}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    };
  }
  return { backgroundImage: `linear-gradient(${angle}, ${contentColor(background.color, '#FFFFFF')}, ${contentColor(background.colorTo, '#FFFFFF')})` };
}

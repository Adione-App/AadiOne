/**
 * One of a restaurant's customer-facing images — the Restaurant Image (Food
 * list card), the Menu Cover Image (menu page hero) or the logo — with its
 * preview and Upload / Replace / Remove. Used by the Admin Panel (Seller →
 * Restaurant) and the Seller Panel (Profile → Restaurant Photos); each passes
 * its own routes, so permissions and ownership stay server-side.
 *
 * After every change the slot re-reads the image from the server (`reload`)
 * and only reports success once the server returns the image just saved.
 * The previews crop like the app does, so what is seen here is what
 * customers see.
 */

import { useEffect, useState } from 'react';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES, validateImage } from '@/lib/upload';
import { Button } from '@/components/ui';

export type RestaurantImageSlotKind = 'restaurant' | 'menuCover' | 'logo';

interface Props {
  kind: RestaurantImageSlotKind;
  title: string;
  hint: string;
  /** The saved image, from the server. */
  url: string | null;
  canEdit: boolean;
  /** Uploads + attaches the file; resolves to the URL the server saved. */
  upload: (file: File) => Promise<string | null>;
  remove: () => Promise<unknown>;
  /** Refetches from the server; resolves to the URL it now holds. */
  reload: () => Promise<string | null>;
  /** Server error -> readable text. */
  errorText: (failure: unknown) => string;
}

type Busy = 'Uploading…' | 'Removing…' | null;

export function RestaurantImageSlot({ kind, title, hint, url, canEdit, upload, remove, reload, errorText }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  async function run(label: Exclude<Busy, null>, action: () => Promise<string | null>, done: string): Promise<void> {
    setNotice(null);
    setBusy(label);
    try {
      const expected = await action();
      const saved = await reload();
      setNotice(
        saved === expected
          ? { ok: true, text: done }
          : { ok: false, text: 'The server did not return the change. Reload the page and try again.' },
      );
    } catch (failure) {
      setNotice({ ok: false, text: errorText(failure) });
    } finally {
      setBusy(null);
    }
  }

  function pick(file: File | undefined): void {
    if (!file) return;
    const invalid = validateImage(file);
    if (invalid) return setNotice({ ok: false, text: invalid });
    void run('Uploading…', () => upload(file), `${title} saved. Customers see it the next time the app loads this screen.`);
  }

  const resolved = url ? imageSrc(url) : null;
  const frame =
    kind === 'logo'
      ? 'mx-auto h-28 w-28 rounded-full'
      : // The menu page hero is 56% of the phone's width tall (≈ 16:9); the Food card crops nearly square.
        'aspect-[16/9] w-full rounded-xl';

  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      <p className="mb-2 text-xs text-gray-500">{hint}</p>
      <div className="flex items-end gap-3">
        <div className={`relative flex flex-1 items-center justify-center overflow-hidden border border-gray-200 bg-gray-50 ${frame}`}>
          {resolved && !broken ? (
            <img src={resolved} alt={title} className="h-full w-full object-cover" onError={() => setBroken(true)} />
          ) : (
            <span className="px-2 text-center text-xs text-gray-400">{resolved ? 'This image could not be loaded.' : 'No image yet'}</span>
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-semibold text-gray-700">
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
              {busy}
            </div>
          )}
        </div>
        {kind === 'restaurant' && resolved && !broken && (
          <div className="shrink-0 text-center">
            <img src={resolved} alt="" className="h-[52px] w-14 rounded-lg border border-gray-200 object-cover" />
            <p className="mt-1 text-[10px] text-gray-500">Food card</p>
          </div>
        )}
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 ${busy ? 'pointer-events-none opacity-50' : ''}`}
          >
            {url ? 'Replace' : 'Upload'}
            <input
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className="sr-only"
              disabled={Boolean(busy)}
              aria-label={`${url ? 'Replace' : 'Upload'} ${title}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                pick(file);
              }}
            />
          </label>
          {url && (
            <Button
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => {
                if (window.confirm(`Remove the ${title}? Customers will no longer see it.`)) {
                  void run(
                    'Removing…',
                    async () => {
                      await remove();
                      return null;
                    },
                    `${title} removed.`,
                  );
                }
              }}
            >
              Remove
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className={`mt-2 text-xs font-medium ${notice.ok ? 'text-brand-700' : 'text-danger-600'}`}>
          {notice.text}
        </p>
      )}
    </div>
  );
}

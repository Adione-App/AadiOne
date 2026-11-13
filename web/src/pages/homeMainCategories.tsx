/**
 * Home page main categories (Banners & Cards page) — which top-level
 * categories the customer Home page shows and in what order
 * (GET/PUT /admin/content/home-categories, config HOME_MAIN_CATEGORIES).
 *
 * Every live main category is listed — the server discovers them from the
 * catalogue on every read, so one a seller creates tomorrow appears here by
 * itself (marked New, shown or hidden by the rule for new categories until
 * the list is saved). Hiding is presentation only: the category, its
 * products, sellers, stock, search and the Categories tab are untouched.
 *
 * Edits stay on this screen until Save; changed rows are marked, leaving the
 * page with unsaved changes asks first, and Reset reloads what is saved.
 * Subcategory sections keep their own settings in the Home Page Builder.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HOME_FEATURED_CATEGORY_MAX, type AdminHomeMainCategoriesDto, type AdminHomeMainCategoryDto } from '@shared';
import { Button, ErrorBanner, Pill, Spinner, Surface, Toggle } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { adminErrorMessage } from '@/lib/marketplace';
import { homeMainCategoriesKey, saveHomeMainCategories, useHomeMainCategories } from '@/lib/content';

type Notice = { ok: boolean; text: string };

interface Row {
  path: string;
  visible: boolean;
  featured: boolean;
}

interface Draft {
  /** Live main categories, in Home order. */
  rows: Row[];
  /** Saved entries whose category is away right now — kept unless forgotten. */
  unavailable: Row[];
  newCategoriesVisible: boolean;
}

interface Editing {
  /** What was saved when this screen loaded it (the comparison for "unsaved"). */
  baseline: Draft;
  draft: Draft;
  /** The saved version the draft builds on (sent back as basedOnUpdatedAt). */
  basedOnUpdatedAt: string | null;
}

const draftOf = (data: AdminHomeMainCategoriesDto): Draft => ({
  rows: data.categories.map(({ path, visible, featured }) => ({ path, visible, featured })),
  unavailable: data.unavailable.map(({ path, visible, featured }) => ({ path, visible, featured })),
  newCategoriesVisible: data.newCategoriesVisible,
});

const editingOf = (data: AdminHomeMainCategoriesDto): Editing => {
  const draft = draftOf(data);
  return { baseline: draft, draft, basedOnUpdatedAt: data.updatedAt };
};

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function HomeMainCategories({ canEdit, onNotice }: { canEdit: boolean; onNotice: (notice: Notice) => void }) {
  const queryClient = useQueryClient();
  const query = useHomeMainCategories();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const dirty = editing ? !same(editing.baseline, editing.draft) : false;

  // Follow the server while nothing is edited (a save, a refetch that found a
  // new category); never replace edits in progress.
  useEffect(() => {
    if (!query.data) return;
    const data = query.data;
    setEditing((current) => (current && !same(current.baseline, current.draft) ? current : editingOf(data)));
  }, [query.data]);

  // Leaving the page with unsaved changes asks first: reloading or closing the
  // tab (beforeunload), and following a link inside the panel (the app uses
  // <BrowserRouter>, which has no navigation blocker, so link clicks are
  // checked here before the router sees them).
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
      if (window.confirm('You have unsaved changes to the Home page main categories. Leave without saving?')) return;
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

  const byPath = useMemo(
    () => new Map<string, AdminHomeMainCategoryDto>((query.data?.categories ?? []).map((category) => [category.path, category])),
    [query.data],
  );

  const save = useMutation({
    mutationFn: (current: Editing) => {
      const all = [...current.draft.rows, ...current.draft.unavailable];
      return saveHomeMainCategories({
        order: all.map((row) => row.path),
        hidden: all.filter((row) => !row.visible).map((row) => row.path),
        featured: all.filter((row) => row.visible && row.featured).map((row) => row.path),
        newCategoriesVisible: current.draft.newCategoriesVisible,
        basedOnUpdatedAt: current.basedOnUpdatedAt,
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(homeMainCategoriesKey, data);
      setEditing(editingOf(data));
      onNotice({ ok: true, text: 'Home page main categories saved. The app shows them on its next Home refresh.' });
    },
    onError: (error) => {
      onNotice({ ok: false, text: adminErrorMessage(error) });
      // Someone saved meanwhile: load their version in the background so the
      // card says so (next to Save) while these edits stay on screen.
      if (error instanceof ApiRequestError && error.code === 'CONTENT_CHANGED') void query.refetch();
    },
  });

  const reset = async () => {
    if (dirty && !window.confirm('Discard your unsaved changes to the Home page main categories?')) return;
    const fresh = await query.refetch();
    if (fresh.data) setEditing(editingOf(fresh.data));
  };

  if (query.isPending) {
    return (
      <Surface className="p-3.5">
        <Spinner label="Loading main categories…" />
      </Surface>
    );
  }
  if (query.isError || !editing) {
    return (
      <Surface className="p-3.5">
        <ErrorBanner message={adminErrorMessage(query.error)} />
      </Surface>
    );
  }

  const { draft, baseline } = editing;
  const update = (next: Partial<Draft>) => setEditing({ ...editing, draft: { ...draft, ...next } });
  const setRow = (path: string, patch: Partial<Row>) =>
    update({ rows: draft.rows.map((row) => (row.path === path ? { ...row, ...patch } : row)) });
  const moveTo = (from: number, to: number) => {
    if (to < 0 || to >= draft.rows.length || from === to) return;
    const rows = [...draft.rows];
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row!);
    update({ rows });
  };

  const baselineIndex = new Map(baseline.rows.map((row, index) => [row.path, { row, index }]));
  const changed = (row: Row, index: number) => {
    const before = baselineIndex.get(row.path);
    return !before || before.index !== index || before.row.visible !== row.visible || before.row.featured !== row.featured;
  };
  const featuredCount = draft.rows.filter((row) => row.visible && row.featured).length;
  const shownCount = draft.rows.filter((row) => row.visible).length;
  const neverSaved = query.data?.updatedAt === null;
  const serverMovedOn = query.data?.updatedAt !== editing.basedOnUpdatedAt;
  let position = 0;

  return (
    <Surface className="p-3.5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">Home page main categories</h2>
        <span className="text-xs text-gray-500">
          {shownCount} shown · {draft.rows.length - shownCount} hidden
          {query.data?.updatedAt
            ? ` · saved ${new Date(query.data.updatedAt).toLocaleString()}${query.data.updatedBy ? ` by ${query.data.updatedBy}` : ''}`
            : ' · not saved yet'}
        </span>
      </div>
      <p className="mb-3 text-sm text-gray-600">
        Every main category in the catalogue is listed here automatically. Choose which ones the customer Home page shows and in
        what order — the tiles in Shop by Category and the category shelves follow this order. Hiding a category only removes it
        from the Home page: its products, sellers, stock, search and the Categories tab are not affected. Featured categories get
        their shelves among the first shopping sections (Home Page Builder → Featured category shelves); the rest appear under Other
        category shelves. Subcategory sections keep their own settings in the Home Page Builder.
      </p>

      {neverSaved && (
        <p className="mb-3 rounded-xl bg-info-50 px-3 py-2 text-sm text-gray-700">
          Not saved yet — Home currently shows every category, with the earlier “shown first” categories (marked Featured) at the
          top. Save once to fix this order.
        </p>
      )}
      {dirty && serverMovedOn && (
        <p className="mb-3 rounded-xl bg-warn-50 px-3 py-2 text-sm text-gray-700">
          Someone saved these categories after you started editing. Saving will be refused — use Reset to load their version.
        </p>
      )}

      {draft.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 px-3 py-4 text-sm text-gray-500">
          No main categories in the catalogue yet. They appear here as soon as a seller adds one.
        </p>
      ) : (
        <ol className="space-y-2" aria-label="Main categories in Home order">
          {draft.rows.map((row, index) => {
            const category = byPath.get(row.path);
            const name = category?.name ?? row.path;
            const isChanged = changed(row, index);
            if (row.visible) position += 1;
            return (
              <li
                key={row.path}
                draggable={canEdit}
                onDragStart={() => setDragging(index)}
                onDragOver={(event) => {
                  if (dragging !== null) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null) moveTo(dragging, index);
                  setDragging(null);
                }}
                onDragEnd={() => setDragging(null)}
                className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                  isChanged ? 'border-warn-500/40 bg-warn-50/60' : 'border-gray-100'
                } ${row.visible ? '' : 'opacity-75'} ${dragging === index ? 'ring-2 ring-brand-200' : ''}`}
              >
                {canEdit && (
                  <span className="cursor-grab select-none text-gray-300" aria-hidden="true" title="Drag to reorder">
                    ⋮⋮
                  </span>
                )}
                <span className="w-6 text-right text-xs font-semibold text-gray-500" title={row.visible ? 'Position on Home' : 'Hidden'}>
                  {row.visible ? position : '—'}
                </span>
                {category?.imageUrl ? (
                  <img src={imageSrc(category.imageUrl)} alt="" className="h-9 w-9 shrink-0 rounded-lg bg-gray-50 object-contain" />
                ) : (
                  <span className="h-9 w-9 shrink-0 rounded-lg bg-gray-100" aria-hidden="true" />
                )}
                {/* At least 9rem for the name: on a phone the controls wrap to their own line instead of squeezing it. */}
                <span className="min-w-[9rem] flex-1">
                  <span className="block truncate font-medium text-gray-900">{name}</span>
                  <span className="flex flex-wrap gap-1 pt-0.5">
                    {!row.visible && <Pill tone="gray">Hidden</Pill>}
                    {row.visible && row.featured && <Pill tone="brand">Featured</Pill>}
                    {category?.isNew && <Pill tone="blue">New</Pill>}
                    {category && category.productCount === 0 && <Pill tone="amber">No products yet</Pill>}
                    {isChanged && <Pill tone="amber">Unsaved</Pill>}
                    {category && (
                      <span className="text-xs text-gray-500">
                        {category.productCount} product{category.productCount === 1 ? '' : 's'} · {category.sellerCount} seller
                        {category.sellerCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs text-gray-600">
                  Show on Home
                  <Toggle
                    checked={row.visible}
                    disabled={!canEdit}
                    label={`Show ${name} on the Home page`}
                    onChange={(visible) => setRow(row.path, visible ? { visible } : { visible, featured: false })}
                  />
                </span>
                <span className="flex items-center gap-2 text-xs text-gray-600">
                  Featured
                  <Toggle
                    checked={row.visible && row.featured}
                    disabled={!canEdit || !row.visible || (!row.featured && featuredCount >= HOME_FEATURED_CATEGORY_MAX)}
                    label={`Feature ${name}'s shelf among the first shopping sections`}
                    onChange={(featured) => setRow(row.path, { featured })}
                  />
                </span>
                {canEdit && (
                  <span className="flex items-center">
                    <Button variant="ghost" disabled={index === 0} onClick={() => moveTo(index, index - 1)} aria-label={`Move ${name} up`}>
                      <span aria-hidden="true">↑</span>
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={index === draft.rows.length - 1}
                      onClick={() => moveTo(index, index + 1)}
                      aria-label={`Move ${name} down`}
                    >
                      <span aria-hidden="true">↓</span>
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {draft.unavailable.length > 0 && (
        <div className="mt-3 rounded-xl border border-dashed border-gray-200 px-3 py-2">
          <h3 className="text-sm font-semibold text-gray-800">Saved, but not in the catalogue right now</h3>
          <p className="mb-2 text-xs text-gray-500">
            A seller removed or paused these. They are kept with their settings and come back by themselves; forget one only if it is
            gone for good.
          </p>
          <ul className="space-y-1">
            {draft.unavailable.map((row) => (
              <li key={row.path} className="flex items-center gap-2 text-sm text-gray-700">
                <span className="min-w-0 flex-1 truncate">
                  {row.path} {row.visible ? '' : '(hidden)'}
                </span>
                {canEdit && (
                  <Button variant="ghost" onClick={() => update({ unavailable: draft.unavailable.filter((entry) => entry.path !== row.path) })}>
                    Forget<span className="sr-only"> {row.path}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <Toggle
            checked={draft.newCategoriesVisible}
            disabled={!canEdit}
            label="Show new main categories on Home automatically"
            onChange={(newCategoriesVisible) => update({ newCategoriesVisible })}
          />
          <span>
            New main categories appear on Home automatically
            <span className="block text-xs text-gray-500">
              {draft.newCategoriesVisible
                ? 'A category created later shows after these, until you arrange it here.'
                : 'A category created later stays hidden from Home until you show it here.'}
            </span>
          </span>
        </label>
        {canEdit && (
          <div className="flex items-center gap-2">
            {dirty && <span className="text-sm font-medium text-amber-700">You have unsaved changes.</span>}
            <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => void reset()}>
              Reset
            </Button>
            <Button disabled={(!dirty && !neverSaved) || save.isPending} onClick={() => save.mutate(editing)}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </div>
    </Surface>
  );
}

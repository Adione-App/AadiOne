/**
 * Category Management — how the marketplace's categories are SHOWN, across
 * the app, without creating a second copy of any category.
 *
 * Categories themselves belong to the sellers (they create them in the
 * Seller Panel; customers see them merged by path). Here the admin decides,
 * as part of the same draft-and-publish Home layout document:
 *
 *   Placements   for every place categories are listed (Home grids, the
 *                Categories page): automatic or hand-picked, in which order,
 *                how many, columns / rows, grid or row, "View all", and the
 *                tile style — each placement on its own, so 8 on Home and 16
 *                on the Categories page never affect each other
 *   Categories   per category: a display name (English / Hindi), tile
 *                colour, text colour, hidden from every placement; and its
 *                image (that one applies immediately — it is the category's
 *                own image, the same as before)
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CATEGORY_COLUMN_LIMITS,
  CATEGORY_COUNT_LIMITS,
  CATEGORY_NAME_MAX,
  CATEGORY_PLACEMENT_INFO,
  CATEGORY_PLACEMENT_KEYS,
  CATEGORY_ROW_LIMITS,
  CATEGORY_TILE_SHAPES,
  Permission,
  categoryPlacementLimit,
  contentColor,
  roleHasPermission,
  type AdminCategoryOptionDto,
  type CategoryPlacementConfig,
  type CategoryPlacementKey,
  type CategoryStyleConfig,
  type HomeLayoutContent,
} from '@shared';
import { Button, EmptyState, ErrorBanner, Field, Icon, Pill, SearchInput, Spinner, Surface, TableWrap, Td, Th, Thumb, Toggle, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES, validateImage } from '@/lib/upload';
import { adminErrorMessage } from '@/lib/marketplace';
import { removeCategoryImage, setCategoryImage, uploadAdminImage } from '@/lib/content';
import { homeLayoutKeys, useCategoryOptions, useLayoutEditor } from '@/lib/homeLayout';
import { ColorPicker, MoveButtons, NoticeLine, PublishBar, moved, type Notice } from './homeLayoutUi';

const SHAPE_LABEL = { rounded: 'Rounded square', circle: 'Circle', square: 'Square' } as const;

export interface PlacedCategory {
  path: string;
  label: string;
  imageUrl: string | null;
  tileBackground: string | null;
}

/**
 * The categories a placement lists, as the app picks them: hidden ones left
 * out; hand-picked in the chosen order, or automatic in catalogue order
 * (subcategories taking turns between their parents, as Home does); at most
 * `maxItems`. The admin preview's approximation of the app's own rule.
 */
export function placementCategories(
  key: CategoryPlacementKey,
  placement: CategoryPlacementConfig,
  styles: readonly CategoryStyleConfig[],
  options: readonly AdminCategoryOptionDto[],
): PlacedCategory[] {
  const style = new Map(styles.map((entry) => [entry.path, entry]));
  const visible = options.filter((option) => !style.get(option.path)?.hidden);
  const level = CATEGORY_PLACEMENT_INFO[key].level;
  let picked: AdminCategoryOptionDto[];
  if (placement.mode === 'manual') {
    const byPath = new Map(visible.map((option) => [option.path, option]));
    picked = placement.paths.map((path) => byPath.get(path)).filter((option): option is AdminCategoryOptionDto => Boolean(option));
  } else if (level === 'sub') {
    const parents = new Map<string, AdminCategoryOptionDto[]>();
    for (const option of visible) if (option.parentPath) parents.set(option.parentPath, [...(parents.get(option.parentPath) ?? []), option]);
    picked = [];
    for (let round = 0; picked.length < placement.maxItems; round += 1) {
      const take = [...parents.values()].map((list) => list[round]).filter((option): option is AdminCategoryOptionDto => Boolean(option));
      if (take.length === 0) break;
      picked.push(...take);
    }
  } else {
    picked = level === 'top' ? visible.filter((option) => option.depth === 0) : [...visible.filter((o) => o.depth === 0), ...visible.filter((o) => o.depth > 0)];
  }
  return picked.slice(0, placement.maxItems).map((option) => {
    const own = style.get(option.path);
    return { path: option.path, label: own?.displayName ?? option.name, imageUrl: option.imageUrl, tileBackground: own?.tileBackground ?? null };
  });
}

export default function CategoryDisplayPage() {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role ? roleHasPermission(role, Permission.CATALOG_WRITE) : false;
  const editor = useLayoutEditor();
  const options = useCategoryOptions();
  const [tab, setTab] = useState<'placements' | 'categories'>('placements');
  const [notice, setNotice] = useState<Notice>(null);

  if (editor.doc.isPending || options.isPending) return <Spinner label="Loading categories…" />;
  if (editor.doc.isError) return <ErrorBanner message={adminErrorMessage(editor.doc.error)} />;
  if (options.isError) return <ErrorBanner message={adminErrorMessage(options.error)} />;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-info-500/20 bg-info-50 px-4 py-3 text-sm text-gray-700">
        <Icon name="categories" className="mt-0.5 h-5 w-5 shrink-0 text-info-500" />
        <p>
          Sellers create their own categories; customers see them merged by name and path. Here you decide{' '}
          <span className="font-semibold">where and how</span> they are shown — each placement on its own, no duplicate categories. These
          settings are part of the Home page draft: publish to make them live. Category images apply immediately.
        </p>
      </div>

      <PublishBar editor={editor} canEdit={canEdit} onNotice={setNotice} />
      <NoticeLine notice={notice} />

      <div className="flex gap-2" role="tablist">
        {(['placements', 'categories'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold ${tab === value ? 'bg-brand-600 text-white' : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50'}`}
          >
            {value === 'placements' ? 'Placements' : `Categories (${options.data.length})`}
          </button>
        ))}
      </div>

      {tab === 'placements' ? (
        <div className="space-y-5">
          {CATEGORY_PLACEMENT_KEYS.map((key) => (
            <PlacementEditor key={key} placementKey={key} layout={editor.layout} options={options.data} canEdit={canEdit} onChange={(change) => editor.update((l) => change(l.categoryPlacements[key]))} />
          ))}
        </div>
      ) : (
        <CategoryTable
          layout={editor.layout}
          options={options.data}
          canEdit={canEdit}
          onNotice={setNotice}
          onStyle={(path, change) =>
            editor.update((l) => {
              const index = l.categoryStyles.findIndex((style) => style.path === path);
              const current: CategoryStyleConfig = index >= 0 ? l.categoryStyles[index]! : { path, displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: false };
              const next = { ...current };
              change(next);
              const empty = !next.displayName && !next.displayNameHi && !next.tileBackground && !next.textColor && !next.hidden;
              if (index >= 0) {
                if (empty) l.categoryStyles.splice(index, 1);
                else l.categoryStyles[index] = next;
              } else if (!empty) l.categoryStyles.push(next);
            })
          }
        />
      )}
    </div>
  );
}

/* Placements ------------------------------------------------------------- */

function PlacementEditor({
  placementKey,
  layout,
  options,
  canEdit,
  onChange,
}: {
  placementKey: CategoryPlacementKey;
  layout: HomeLayoutContent;
  options: AdminCategoryOptionDto[];
  canEdit: boolean;
  onChange: (change: (placement: CategoryPlacementConfig) => void) => void;
}) {
  const info = CATEGORY_PLACEMENT_INFO[placementKey];
  const placement = layout.categoryPlacements[placementKey];
  // The Categories tab draws its own tiles: there only which categories, order, count, per-row and rows apply.
  const styled = placementKey !== 'categories_page';
  const [search, setSearch] = useState('');
  const shown = placementCategories(placementKey, placement, layout.categoryStyles, options);
  const columns = placement.columns ?? 4;
  const visibleCount = Math.min(shown.length, categoryPlacementLimit(placement, columns));
  const byPath = new Map(options.map((option) => [option.path, option]));
  const eligible = options.filter((option) => (info.level === 'top' ? option.depth === 0 : info.level === 'sub' ? option.depth > 0 : true));
  const addable = eligible.filter((option) => !placement.paths.includes(option.path) && (!search || `${option.name} ${option.path}`.toLowerCase().includes(search.toLowerCase())));

  return (
    <Surface className="space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{info.label}</h2>
          <p className="text-sm text-gray-500">{info.hint}</p>
        </div>
        <Pill tone="gray">
          {visibleCount} shown{placement.layout === 'grid' ? ` · ${placement.columns ?? 'auto'} per row` : ' · one scrolling row'}
        </Pill>
      </div>

      <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
        <Field label="Which categories">
          <select className={inputClass} value={placement.mode} onChange={(event) => onChange((p) => void (p.mode = event.target.value as 'auto'))}>
            <option value="auto">Automatic (catalogue order)</option>
            <option value="manual">Choose categories</option>
          </select>
        </Field>
        <Field label="How many at most" hint={`${CATEGORY_COUNT_LIMITS.min}–${CATEGORY_COUNT_LIMITS.max}`}>
          <input
            type="number"
            className={inputClass}
            min={CATEGORY_COUNT_LIMITS.min}
            max={CATEGORY_COUNT_LIMITS.max}
            value={placement.maxItems}
            onChange={(event) => {
              const value = Math.round(Number(event.target.value));
              if (Number.isFinite(value)) onChange((p) => void (p.maxItems = Math.min(CATEGORY_COUNT_LIMITS.max, Math.max(CATEGORY_COUNT_LIMITS.min, value))));
            }}
          />
        </Field>
        {styled && (
          <Field label="Layout">
            <select className={inputClass} value={placement.layout} onChange={(event) => onChange((p) => void (p.layout = event.target.value as 'grid'))}>
              <option value="grid">Grid</option>
              <option value="row">One scrolling row</option>
            </select>
          </Field>
        )}
        {(placement.layout === 'grid' || !styled) && (
          <>
            <Field label="Per row">
              <select
                className={inputClass}
                value={placement.columns ?? 'auto'}
                onChange={(event) => onChange((p) => void (p.columns = event.target.value === 'auto' ? null : Number(event.target.value)))}
              >
                <option value="auto">As many as fit</option>
                {Array.from({ length: CATEGORY_COLUMN_LIMITS.max - CATEGORY_COLUMN_LIMITS.min + 1 }, (_, i) => CATEGORY_COLUMN_LIMITS.min + i).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Rows" hint="Empty = no limit (only “how many”).">
              <input
                type="number"
                className={inputClass}
                min={CATEGORY_ROW_LIMITS.min}
                max={CATEGORY_ROW_LIMITS.max}
                value={placement.rows ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  const value = Math.round(Number(raw));
                  onChange((p) => void (p.rows = raw === '' || !Number.isFinite(value) ? null : Math.min(CATEGORY_ROW_LIMITS.max, Math.max(CATEGORY_ROW_LIMITS.min, value))));
                }}
              />
            </Field>
          </>
        )}
        {styled && (
          <>
            <Field label="Tile shape">
              <select className={inputClass} value={placement.tileShape} onChange={(event) => onChange((p) => void (p.tileShape = event.target.value as 'rounded'))}>
                {CATEGORY_TILE_SHAPES.map((shape) => (
                  <option key={shape} value={shape}>
                    {SHAPE_LABEL[shape]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Image">
              <select className={inputClass} value={placement.imageFit} onChange={(event) => onChange((p) => void (p.imageFit = event.target.value as 'cover'))}>
                <option value="cover">Fill the tile (may crop)</option>
                <option value="contain">Show the whole image</option>
              </select>
            </Field>
            <Field label="Tile colour">
              <ColorPicker label={`${info.label} tile colour`} value={placement.tileBackground} onChange={(value) => onChange((p) => void (p.tileBackground = value))} />
            </Field>
            <div className="flex items-end">
              <Toggle label="“View all” link" checked={placement.showViewAll} disabled={!canEdit} onChange={(next) => onChange((p) => void (p.showViewAll = next))} />
            </div>
          </>
        )}
      </fieldset>

      {placement.mode === 'manual' && (
        <div className="grid gap-4 border-t border-gray-100 pt-4 md:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-semibold text-gray-900">Chosen, in order ({placement.paths.length})</p>
            {placement.paths.length === 0 ? (
              <EmptyState title="None chosen yet" hint="Add categories from the list. Publishing needs at least one." />
            ) : (
              <ol className="space-y-1.5">
                {placement.paths.map((path, index) => {
                  const option = byPath.get(path);
                  return (
                    <li key={path} className="flex items-center gap-2 rounded-lg border border-gray-100 px-2 py-1.5 text-sm">
                      {canEdit && <MoveButtons index={index} count={placement.paths.length} onMove={(to) => onChange((p) => void (p.paths = moved(p.paths, index, to)))} label={option?.name ?? path} />}
                      <Thumb src={imageSrc(option?.imageUrl)} alt={option?.name ?? path} />
                      <span className="min-w-0 flex-1 truncate">
                        {option?.name ?? <span className="text-danger-600">{path} — no longer live</span>}
                        <span className="ml-1 text-xs text-gray-400">{path}</span>
                      </span>
                      {canEdit && (
                        <Button variant="ghost" onClick={() => onChange((p) => void (p.paths = p.paths.filter((entry) => entry !== path)))}>
                          <Icon name="close" className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {canEdit && (
            <div>
              <SearchInput value={search} onChange={setSearch} placeholder={`Find a ${info.level === 'sub' ? 'subcategory' : 'category'}…`} />
              <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                {addable.slice(0, 50).map((option) => (
                  <li key={option.path}>
                    <button
                      type="button"
                      disabled={placement.paths.length >= CATEGORY_COUNT_LIMITS.max}
                      onClick={() => onChange((p) => void (p.paths = [...p.paths, option.path]))}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-brand-50 disabled:opacity-40"
                    >
                      <Icon name="plus" className="h-4 w-4 text-brand-600" />
                      <span className="flex-1 truncate">{option.name}</span>
                      <span className="text-xs text-gray-400">{option.productCount} products</span>
                    </button>
                  </li>
                ))}
                {addable.length === 0 && <li className="px-2 py-1.5 text-sm text-gray-500">Nothing else to add.</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Preview of the tiles, with this placement's style ------------------- */}
      <div className="border-t border-gray-100 pt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Preview</p>
        {shown.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing to show — this placement is left out of the app.</p>
        ) : (
          <div
            className={placement.layout === 'row' ? 'flex gap-3 overflow-x-auto' : 'grid max-w-md gap-3'}
            style={placement.layout === 'row' ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {shown.slice(0, visibleCount).map((category) => (
              <div key={category.path} className={`text-center ${placement.layout === 'row' ? 'w-20 shrink-0' : ''}`}>
                <div
                  className={`aspect-square w-full overflow-hidden ${placement.tileShape === 'circle' ? 'rounded-full' : placement.tileShape === 'square' ? '' : 'rounded-xl'}`}
                  style={{ background: contentColor(category.tileBackground ?? placement.tileBackground, '#F1F9F3') }}
                >
                  {category.imageUrl && <img src={imageSrc(category.imageUrl)} alt="" className={`h-full w-full ${placement.imageFit === 'contain' ? 'object-contain' : 'object-cover'}`} />}
                </div>
                <p className="mt-1 truncate text-xs font-medium text-gray-700">{category.label}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Surface>
  );
}

/* Categories --------------------------------------------------------------- */

const PAGE_SIZE = 25;

function CategoryTable({
  layout,
  options,
  canEdit,
  onNotice,
  onStyle,
}: {
  layout: HomeLayoutContent;
  options: AdminCategoryOptionDto[];
  canEdit: boolean;
  onNotice: (notice: Notice) => void;
  onStyle: (path: string, change: (style: CategoryStyleConfig) => void) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'top' | 'sub' | 'customised' | 'hidden'>('all');
  const [page, setPage] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const styles = useMemo(() => new Map(layout.categoryStyles.map((style) => [style.path, style])), [layout.categoryStyles]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return options.filter((option) => {
      const style = styles.get(option.path);
      if (filter === 'top' && option.depth !== 0) return false;
      if (filter === 'sub' && option.depth === 0) return false;
      if (filter === 'customised' && !style) return false;
      if (filter === 'hidden' && !style?.hidden) return false;
      return !term || `${option.name} ${option.nameHi ?? ''} ${option.path} ${style?.displayName ?? ''}`.toLowerCase().includes(term);
    });
  }, [options, styles, search, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);

  const image = async (option: AdminCategoryOptionDto, file: File | null) => {
    if (file) {
      const problem = validateImage(file);
      if (problem) return onNotice({ ok: false, text: problem });
    }
    setBusyPath(option.path);
    try {
      if (file) await setCategoryImage(option.id, await uploadAdminImage(file, 'category'));
      else await removeCategoryImage(option.id);
      await queryClient.invalidateQueries({ queryKey: homeLayoutKeys.categories });
      onNotice({ ok: true, text: `${option.name}: image ${file ? 'updated' : 'removed'} (applies immediately, for every seller's ${option.name}).` });
    } catch (error) {
      onNotice({ ok: false, text: adminErrorMessage(error) });
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={(next) => { setSearch(next); setPage(0); }} placeholder="Search categories…" className="min-w-[240px] flex-1" />
        <select className={`${inputClass} w-auto`} value={filter} onChange={(event) => { setFilter(event.target.value as 'all'); setPage(0); }} aria-label="Filter categories">
          <option value="all">All</option>
          <option value="top">Top categories</option>
          <option value="sub">Subcategories</option>
          <option value="customised">Customised</option>
          <option value="hidden">Hidden</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No categories match" hint={options.length === 0 ? 'Sellers have not created any categories yet.' : 'Try another search or filter.'} />
      ) : (
        <TableWrap>
          <table className="min-w-full divide-y divide-gray-100 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>Category</Th>
                <Th>Sellers · products</Th>
                <Th>Display name (English / हिन्दी)</Th>
                <Th>Tile colour</Th>
                <Th>Text</Th>
                <Th>Shown</Th>
                <Th>Image</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((option) => {
                const style = styles.get(option.path);
                return (
                  <tr key={option.path} className={style?.hidden ? 'bg-gray-50 text-gray-500' : ''}>
                    <Td>
                      <div className={`flex items-center gap-2 ${option.depth > 0 ? 'pl-6' : ''}`}>
                        <Thumb src={imageSrc(option.imageUrl)} alt={option.name} />
                        <div>
                          <p className="font-semibold text-gray-900">{option.name}</p>
                          <p className="text-xs text-gray-400">{option.path}</p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      {option.sellerCount} · {option.productCount}
                    </Td>
                    <Td>
                      <fieldset disabled={!canEdit} className="flex flex-col gap-1">
                        <input
                          aria-label={`${option.name} display name`}
                          className={inputClass}
                          maxLength={CATEGORY_NAME_MAX}
                          placeholder={option.name}
                          value={style?.displayName ?? ''}
                          onChange={(event) => onStyle(option.path, (s) => void (s.displayName = event.target.value || null))}
                        />
                        <input
                          aria-label={`${option.name} Hindi display name`}
                          className={inputClass}
                          maxLength={CATEGORY_NAME_MAX}
                          placeholder={option.nameHi ?? 'हिन्दी नाम'}
                          value={style?.displayNameHi ?? ''}
                          onChange={(event) => onStyle(option.path, (s) => void (s.displayNameHi = event.target.value || null))}
                        />
                      </fieldset>
                    </Td>
                    <Td>
                      <fieldset disabled={!canEdit}>
                        {style?.tileBackground ? (
                          <div className="flex items-center gap-1">
                            <ColorPicker label={`${option.name} tile colour`} value={style.tileBackground} onChange={(value) => onStyle(option.path, (s) => void (s.tileBackground = value))} />
                            <Button variant="ghost" onClick={() => onStyle(option.path, (s) => void (s.tileBackground = null))}>
                              Reset
                            </Button>
                          </div>
                        ) : (
                          <Button variant="soft" onClick={() => onStyle(option.path, (s) => void (s.tileBackground = 'peach'))}>
                            Placement colour — change
                          </Button>
                        )}
                      </fieldset>
                    </Td>
                    <Td>
                      <select
                        aria-label={`${option.name} text colour`}
                        disabled={!canEdit}
                        className={`${inputClass} w-auto`}
                        value={style?.textColor ?? ''}
                        onChange={(event) => onStyle(option.path, (s) => void (s.textColor = (event.target.value || null) as 'dark' | null))}
                      >
                        <option value="">Standard</option>
                        <option value="dark">Dark</option>
                        <option value="light">White</option>
                      </select>
                    </Td>
                    <Td>
                      <Toggle label={style?.hidden ? 'Hidden' : 'Shown'} checked={!style?.hidden} disabled={!canEdit} onChange={(next) => onStyle(option.path, (s) => void (s.hidden = !next))} />
                    </Td>
                    <Td>
                      {canEdit && (
                        <div className="flex items-center gap-1">
                          <label className="cursor-pointer rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
                            {busyPath === option.path ? '…' : option.imageUrl ? 'Replace' : 'Upload'}
                            <input
                              type="file"
                              accept={ACCEPTED_IMAGE_TYPES.join(',')}
                              className="sr-only"
                              disabled={busyPath !== null}
                              onChange={(event) => {
                                const file = event.target.files?.[0] ?? null;
                                event.target.value = '';
                                if (file) void image(option, file);
                              }}
                            />
                          </label>
                          {option.imageUrl && (
                            <Button variant="ghost" disabled={busyPath !== null} onClick={() => window.confirm(`Remove the image of ${option.name} for every seller?`) && void image(option, null)}>
                              <Icon name="trash" className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-gray-600">
          <Button variant="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>
            <Icon name="chevronLeft" className="h-4 w-4" />
          </Button>
          Page {current + 1} of {pages} · {rows.length} categories
          <Button variant="secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            <Icon name="chevronRight" className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

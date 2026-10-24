/**
 * Home Page Builder — the editors of ADDED sections (shared home-layout.ts /
 * home-builder.ts):
 *
 *   ShelfEditor            one product shelf: where its products come from
 *                          (random daily, latest, best-selling, hand-picked),
 *                          from which categories, how many, carousel or grid,
 *                          card size, gap, View All — and a live preview of
 *                          what customers get right now (the server resolves it)
 *   CategorySectionEditor  one category section: the same category list editor
 *                          as Category Management, plus what "automatic" lists
 *                          and the tiles' text colour
 *
 * Every shelf is edited on its own; nothing here changes another section.
 * Products and categories are referenced by id / path only — prices, stock
 * and names always come live from the catalogue.
 */

import { useMemo, useState } from 'react';
import {
  CATEGORY_PLACEMENT_INFO,
  PRODUCT_SHELF_CARD_SIZES,
  PRODUCT_SHELF_COUNT_LIMITS,
  PRODUCT_SHELF_COUNT_PRESETS,
  PRODUCT_SHELF_GAPS,
  PRODUCT_SHELF_PICK_MAX,
  PRODUCT_SHELF_SCOPE_MAX,
  PRODUCT_SHELF_SOURCES,
  PRODUCT_SHELF_SOURCE_INFO,
  formatPaise,
  productShelfViewAllOptions,
  productShelfViewAllProblem,
  type AdminCategoryOptionDto,
  type AdminProductOptionDto,
  type CategoryStyleConfig,
  type HomeCategorySectionConfig,
  type ProductShelfConfig,
} from '@shared';
import { Button, EmptyState, Field, Icon, Pill, SearchInput, Spinner, Thumb, Toggle, inputClass } from '@/components/ui';
import { imageSrc } from '@/lib/image';
import { adminErrorMessage, useSellerOptions } from '@/lib/marketplace';
import { useProductOptions, useProductsByIds, useShelfPreview } from '@/lib/homeLayout';
import { CategoryListEditor } from './CategoryDisplay';
import { DragHandle, MoveButtons, moved, useDragReorder } from './homeLayoutUi';

const CARD_SIZE_LABEL = { compact: 'Small', regular: 'Standard', large: 'Large' } as const;
const GAP_LABEL = { tight: 'Tight', normal: 'Normal', wide: 'Wide' } as const;

/** "Grocery › Rice" for a path, from the live category options. */
export function categoryPathLabel(path: string, byPath: Map<string, AdminCategoryOptionDto>): string {
  const option = byPath.get(path);
  if (!option) return path;
  const parent = option.parentPath ? byPath.get(option.parentPath) : undefined;
  return parent ? `${parent.name} › ${option.name}` : option.name;
}

function viewAllLabel(viewAll: ProductShelfConfig['viewAll'], byPath: Map<string, AdminCategoryOptionDto>): string {
  if (viewAll.type === 'none') return 'No “View All”';
  if (viewAll.type === 'latest') return 'All latest products';
  if (viewAll.type === 'bestselling') return 'All best-selling products (Top picks)';
  return `Category: ${viewAll.path ? categoryPathLabel(viewAll.path, byPath) : '—'}`;
}

/* -------------------------------------------------------------------------- */
/* Product shelf                                                               */
/* -------------------------------------------------------------------------- */

export function ShelfEditor({
  sectionId,
  shelf,
  options,
  canEdit,
  onChange,
}: {
  sectionId: string;
  shelf: ProductShelfConfig;
  options: AdminCategoryOptionDto[];
  canEdit: boolean;
  onChange: (change: (shelf: ProductShelfConfig) => void) => void;
}) {
  const byPath = useMemo(() => new Map(options.map((option) => [option.path, option])), [options]);
  const viewAllProblem = productShelfViewAllProblem(shelf);
  const viewAllChoices = productShelfViewAllOptions(shelf);
  const current = JSON.stringify(shelf.viewAll);
  const choices = [{ type: 'none', path: null } as ProductShelfConfig['viewAll'], ...viewAllChoices];
  if (!choices.some((choice) => JSON.stringify(choice) === current)) choices.push(shelf.viewAll);
  const isPreset = (PRODUCT_SHELF_COUNT_PRESETS as readonly number[]).includes(shelf.count);

  return (
    <div className="space-y-4">
      <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
        <Field label="Products come from" hint={PRODUCT_SHELF_SOURCE_INFO[shelf.source].hint}>
          <select className={inputClass} value={shelf.source} onChange={(event) => onChange((s) => void (s.source = event.target.value as ProductShelfConfig['source']))}>
            {PRODUCT_SHELF_SOURCES.map((source) => (
              <option key={source} value={source}>
                {PRODUCT_SHELF_SOURCE_INFO[source].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How many products" hint={`At most ${PRODUCT_SHELF_COUNT_LIMITS.max}. Fewer show when fewer qualify — never empty slots.`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {PRODUCT_SHELF_COUNT_PRESETS.map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => onChange((s) => void (s.count = count))}
                className={`rounded-lg border px-2.5 py-1 text-sm font-semibold ${shelf.count === count ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}
                aria-pressed={shelf.count === count}
              >
                {count}
              </button>
            ))}
            <input
              type="number"
              aria-label="Custom number of products"
              className={`${inputClass} w-20 ${isPreset ? '' : 'ring-2 ring-brand-500'}`}
              min={PRODUCT_SHELF_COUNT_LIMITS.min}
              max={PRODUCT_SHELF_COUNT_LIMITS.max}
              value={shelf.count}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                if (Number.isFinite(value)) onChange((s) => void (s.count = Math.min(PRODUCT_SHELF_COUNT_LIMITS.max, Math.max(PRODUCT_SHELF_COUNT_LIMITS.min, value))));
              }}
            />
          </div>
        </Field>
      </fieldset>

      <CategoryScope shelf={shelf} options={options} byPath={byPath} canEdit={canEdit} onChange={onChange} />

      {shelf.source === 'manual' && <ProductPicker shelf={shelf} options={options} byPath={byPath} canEdit={canEdit} onChange={onChange} />}

      <fieldset disabled={!canEdit} className="grid gap-4 border-t border-gray-100 pt-4 md:grid-cols-4">
        <Field label="Layout">
          <select className={inputClass} value={shelf.layout} onChange={(event) => onChange((s) => void (s.layout = event.target.value as 'carousel'))}>
            <option value="carousel">Scrolling row (carousel)</option>
            <option value="grid">Grid</option>
          </select>
        </Field>
        {shelf.layout === 'grid' ? (
          <Field label="Per row" hint="3 per row becomes 2 on small phones.">
            <select className={inputClass} value={shelf.columns} onChange={(event) => onChange((s) => void (s.columns = Number(event.target.value) === 3 ? 3 : 2))}>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </Field>
        ) : (
          <Field label="Card size">
            <select className={inputClass} value={shelf.cardSize} onChange={(event) => onChange((s) => void (s.cardSize = event.target.value as 'regular'))}>
              {PRODUCT_SHELF_CARD_SIZES.map((size) => (
                <option key={size} value={size}>
                  {CARD_SIZE_LABEL[size]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Gap between cards">
          <select className={inputClass} value={shelf.gap} onChange={(event) => onChange((s) => void (s.gap = event.target.value as 'normal'))}>
            {PRODUCT_SHELF_GAPS.map((gap) => (
              <option key={gap} value={gap}>
                {GAP_LABEL[gap]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="“View All” opens">
          <select
            className={inputClass}
            value={current}
            onChange={(event) => onChange((s) => void (s.viewAll = JSON.parse(event.target.value) as ProductShelfConfig['viewAll']))}
          >
            {choices.map((choice) => (
              <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                {viewAllLabel(choice, byPath)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      {viewAllProblem ? (
        <p className="text-xs font-medium text-danger-600" role="alert">
          {viewAllProblem}
        </p>
      ) : viewAllChoices.length === 0 && shelf.viewAll.type === 'none' ? (
        <p className="text-xs text-gray-500">No “View All” fits this shelf: it is not limited to one category (or one main category). Choose its categories to offer one.</p>
      ) : null}

      <ShelfPreview sectionId={sectionId} shelf={shelf} />
    </div>
  );
}

/** The categories a shelf takes its products from (and filters the product picker by). */
function CategoryScope({
  shelf,
  options,
  byPath,
  canEdit,
  onChange,
}: {
  shelf: ProductShelfConfig;
  options: AdminCategoryOptionDto[];
  byPath: Map<string, AdminCategoryOptionDto>;
  canEdit: boolean;
  onChange: (change: (shelf: ProductShelfConfig) => void) => void;
}) {
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<'all' | 'top' | 'sub'>('all');
  const term = search.trim().toLowerCase();
  const addable = options.filter((option) => {
    if (shelf.categoryPaths.includes(option.path)) return false;
    if (level === 'top' && option.depth !== 0) return false;
    if (level === 'sub' && option.depth === 0) return false;
    if (!term) return true;
    const parent = option.parentPath ? byPath.get(option.parentPath) : undefined;
    return [option.name, option.nameHi, parent?.name, parent?.nameHi, option.path].some((value) => value?.toLowerCase().includes(term));
  });
  const drag = useDragReorder((from, to) => onChange((s) => void (s.categoryPaths = moved(s.categoryPaths, from, to))));
  const manual = shelf.source === 'manual';

  return (
    <div className="grid gap-4 border-t border-gray-100 pt-4 md:grid-cols-2">
      <div>
        <p className="text-sm font-semibold text-gray-900">
          Categories ({shelf.categoryPaths.length}/{PRODUCT_SHELF_SCOPE_MAX})
        </p>
        <p className="mb-2 text-xs text-gray-500">
          {manual
            ? 'Used to filter the product list below and, if you top the shelf up, where the extra products come from.'
            : 'Only products of these categories (a main category includes its subcategories). None = the whole catalogue.'}
        </p>
        {shelf.categoryPaths.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-sm text-gray-500">Whole catalogue</p>
        ) : (
          <ol className="space-y-1.5">
            {shelf.categoryPaths.map((path, index) => (
              <li key={path} {...drag.dropProps(index)} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${drag.over === index ? 'border-brand-400 bg-brand-50' : 'border-gray-100'}`}>
                {canEdit && <DragHandle label={path} {...drag.handleProps(index)} />}
                {canEdit && <MoveButtons index={index} count={shelf.categoryPaths.length} onMove={(to) => onChange((s) => void (s.categoryPaths = moved(s.categoryPaths, index, to)))} label={path} />}
                <Thumb src={imageSrc(byPath.get(path)?.imageUrl)} alt={path} />
                <span className="min-w-0 flex-1 truncate">
                  {byPath.has(path) ? categoryPathLabel(path, byPath) : <span className="text-danger-600">{path} — no longer live</span>}
                </span>
                {canEdit && (
                  <Button variant="ghost" aria-label={`Remove ${path}`} onClick={() => onChange((s) => void (s.categoryPaths = s.categoryPaths.filter((entry) => entry !== path)))}>
                    <Icon name="close" className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {canEdit && (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search categories (English or हिन्दी)…" className="min-w-[180px] flex-1" />
            <select aria-label="Show" className={`${inputClass} w-auto`} value={level} onChange={(event) => setLevel(event.target.value as 'all')}>
              <option value="all">All</option>
              <option value="top">Main categories</option>
              <option value="sub">Subcategories</option>
            </select>
          </div>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {addable.slice(0, 50).map((option) => (
              <li key={option.path}>
                <button
                  type="button"
                  disabled={shelf.categoryPaths.length >= PRODUCT_SHELF_SCOPE_MAX}
                  onClick={() =>
                    onChange((s) => {
                      s.categoryPaths = [...s.categoryPaths, option.path];
                      // A fresh single-category shelf opens that category from View All.
                      if (s.viewAll.type !== 'category' && s.categoryPaths.length === 1) s.viewAll = { type: 'category', path: option.path };
                      if (s.viewAll.type === 'latest' || s.viewAll.type === 'bestselling') s.viewAll = { type: 'none', path: null };
                    })
                  }
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-brand-50 disabled:opacity-40"
                >
                  <Icon name="plus" className="h-4 w-4 text-brand-600" />
                  <span className="flex-1 truncate">{categoryPathLabel(option.path, byPath)}</span>
                  <span className="text-xs text-gray-400">{option.productCount} products</span>
                </button>
              </li>
            ))}
            {addable.length === 0 && <li className="px-2 py-1.5 text-sm text-gray-500">Nothing else to add.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProductLine({ product }: { product: AdminProductOptionDto }) {
  return (
    <>
      <Thumb src={imageSrc(product.imageUrl)} alt={product.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-gray-900">{product.name}</span>
        <span className="block truncate text-xs text-gray-500">
          {product.categoryLabel}
          {product.brandName ? ` · ${product.brandName}` : ''}
          {product.variantCount > 1 ? ` · ${product.variantCount} sizes` : ''}
        </span>
      </span>
      <span className="shrink-0 text-right text-xs">
        {product.pricePaise !== null ? (
          <span className="block font-semibold text-gray-900">
            {formatPaise(product.pricePaise)}
            {product.mrpPaise !== null && product.mrpPaise > product.pricePaise && <span className="ml-1 font-normal text-gray-400 line-through">{formatPaise(product.mrpPaise)}</span>}
          </span>
        ) : null}
        {product.available ? <Pill tone="brand">Available</Pill> : <Pill tone="amber">Not buyable now</Pill>}
      </span>
    </>
  );
}

/** Hand-picked products: search, filter, add, reorder (drag or ↑ / ↓), remove; optional top-up. */
function ProductPicker({
  shelf,
  options,
  byPath,
  canEdit,
  onChange,
}: {
  shelf: ProductShelfConfig;
  options: AdminCategoryOptionDto[];
  byPath: Map<string, AdminCategoryOptionDto>;
  canEdit: boolean;
  onChange: (change: (shelf: ProductShelfConfig) => void) => void;
}) {
  const [q, setQ] = useState('');
  const [categoryPath, setCategoryPath] = useState('');
  const [sellerId, setSellerId] = useState('');
  const sellers = useSellerOptions(canEdit);
  const search = useProductOptions({ q, categoryPath, sellerId }, canEdit);
  const chosen = useProductsByIds(shelf.productIds);
  const chosenById = new Map((chosen.data?.items ?? []).map((product) => [product.id, product]));
  const results = (search.data?.pages ?? []).flatMap((page) => page.items).filter((product) => !shelf.productIds.includes(product.id));
  const drag = useDragReorder((from, to) => onChange((s) => void (s.productIds = moved(s.productIds, from, to))));
  const full = shelf.productIds.length >= PRODUCT_SHELF_PICK_MAX;
  const filterPaths = shelf.categoryPaths.length > 0 ? shelf.categoryPaths : options.map((option) => option.path);

  return (
    <div className="space-y-3 border-t border-gray-100 pt-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold text-gray-900">
            Chosen products, in order ({shelf.productIds.length}/{PRODUCT_SHELF_PICK_MAX})
          </p>
          {shelf.productIds.length === 0 ? (
            <EmptyState title="None chosen yet" hint="Add products from the list. Publishing needs at least one (or turn on topping up)." />
          ) : (
            <ol className="space-y-1.5">
              {shelf.productIds.map((id, index) => {
                const product = chosenById.get(id);
                return (
                  <li key={id} {...drag.dropProps(index)} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${drag.over === index ? 'border-brand-400 bg-brand-50' : 'border-gray-100'}`}>
                    {canEdit && <DragHandle label={product?.name ?? id} {...drag.handleProps(index)} />}
                    {canEdit && <MoveButtons index={index} count={shelf.productIds.length} onMove={(to) => onChange((s) => void (s.productIds = moved(s.productIds, index, to)))} label={product?.name ?? 'product'} />}
                    <span className="w-6 shrink-0 text-center text-xs font-semibold text-gray-400">{index + 1}</span>
                    {product ? (
                      <ProductLine product={product} />
                    ) : chosen.isPending ? (
                      <span className="flex-1 text-gray-400">Loading…</span>
                    ) : (
                      <span className="flex-1 text-danger-600">No longer published — remove it</span>
                    )}
                    {canEdit && (
                      <Button variant="ghost" aria-label={`Remove ${product?.name ?? 'product'}`} onClick={() => onChange((s) => void (s.productIds = s.productIds.filter((entry) => entry !== id)))}>
                        <Icon name="close" className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <div className="mt-3">
            <Toggle
              label="Top up with the latest products from its categories"
              checked={shelf.fillFromScope}
              disabled={!canEdit}
              onChange={(next) => onChange((s) => void (s.fillFromScope = next))}
            />
            <p className="mt-1 text-xs text-gray-500">Off: only your chosen products. On: your products first, then the newest others until the shelf has {shelf.count}.</p>
          </div>
        </div>
        {canEdit && (
          <div>
            <div className="grid gap-2 sm:grid-cols-3">
              <SearchInput value={q} onChange={setQ} placeholder="Search products (English, हिन्दी or brand)…" className="sm:col-span-3" />
              <select aria-label="Category" className={inputClass} value={categoryPath} onChange={(event) => setCategoryPath(event.target.value)}>
                <option value="">All categories</option>
                {filterPaths.map((path) => (
                  <option key={path} value={path}>
                    {categoryPathLabel(path, byPath)}
                  </option>
                ))}
              </select>
              <select aria-label="Seller" className={`${inputClass} sm:col-span-2`} value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
                <option value="">All sellers</option>
                {(sellers.data ?? []).map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.name}
                  </option>
                ))}
              </select>
            </div>
            {search.isError && <p className="mt-2 text-sm text-danger-600">{adminErrorMessage(search.error)}</p>}
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto">
              {results.map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    disabled={full}
                    onClick={() => onChange((s) => void (s.productIds = [...s.productIds, product.id]))}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-brand-50 disabled:opacity-40"
                  >
                    <Icon name="plus" className="h-4 w-4 shrink-0 text-brand-600" />
                    <ProductLine product={product} />
                  </button>
                </li>
              ))}
              {search.isPending && <li className="px-2 py-1.5 text-sm text-gray-500">Searching…</li>}
              {!search.isPending && results.length === 0 && <li className="px-2 py-1.5 text-sm text-gray-500">No products match.</li>}
            </ul>
            {search.hasNextPage && (
              <Button variant="secondary" className="mt-2" disabled={search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>
                {search.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** What customers get from this shelf right now (resolved by the server, unsaved edits included). */
function ShelfPreview({ sectionId, shelf }: { sectionId: string; shelf: ProductShelfConfig }) {
  const preview = useShelfPreview(sectionId, shelf);
  const products = preview.data ?? [];
  return (
    <div className="border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Customers see now {preview.isFetching && <span className="font-normal normal-case text-gray-400">· updating…</span>}
      </p>
      {preview.isPending ? (
        <Spinner label="Finding products…" />
      ) : preview.isError ? (
        <p className="text-sm text-danger-600">{adminErrorMessage(preview.error)}</p>
      ) : products.length === 0 ? (
        <p className="text-sm text-gray-500">No product qualifies right now — the shelf is left out of the app until one does.</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-500">
            {products.length} of up to {shelf.count} product{shelf.count === 1 ? '' : 's'}
            {shelf.source === 'random' ? ' · today’s selection (changes daily)' : ''}
          </p>
          <div className={shelf.layout === 'grid' ? `grid gap-2 ${shelf.columns === 3 ? 'grid-cols-3' : 'grid-cols-2'} max-w-md` : 'flex gap-2 overflow-x-auto pb-1'}>
            {products.map((product) => (
              <div key={product.id} className={`rounded-xl border border-gray-100 p-1.5 ${shelf.layout === 'grid' ? '' : 'w-28 shrink-0'}`}>
                <div className="aspect-square overflow-hidden rounded-lg bg-gray-50">
                  {product.imageUrl && <img src={imageSrc(product.imageUrl)} alt="" className="h-full w-full object-contain" />}
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] font-medium leading-tight text-gray-800">{product.name}</p>
                {product.defaultVariant && <p className="text-[11px] font-semibold text-gray-900">{formatPaise(product.defaultVariant.pricePaise)}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Category section                                                            */
/* -------------------------------------------------------------------------- */

export function CategorySectionEditor({
  config,
  styles,
  options,
  canEdit,
  onChange,
}: {
  config: HomeCategorySectionConfig;
  styles: readonly CategoryStyleConfig[];
  options: AdminCategoryOptionDto[];
  canEdit: boolean;
  onChange: (change: (config: HomeCategorySectionConfig) => void) => void;
}) {
  return (
    <CategoryListEditor
      title="Categories in this section"
      hint="Chosen categories in your order, or automatic. On its own: other category grids do not change what this one shows."
      placement={config}
      level={config.level}
      styles={styles}
      options={options}
      canEdit={canEdit}
      onChange={onChange}
      extraFields={
        <>
          {config.mode === 'auto' && (
            <Field label="Automatic lists">
              <select className={inputClass} value={config.level} onChange={(event) => onChange((c) => void (c.level = event.target.value as 'top'))}>
                <option value="top">{CATEGORY_PLACEMENT_INFO.home_top.label.replace('Home — ', '')}: main categories</option>
                <option value="sub">Subcategories (taking turns between main categories)</option>
                <option value="any">Main categories, then subcategories</option>
              </select>
            </Field>
          )}
          <Field label="Text colour">
            <select className={inputClass} value={config.textColor ?? ''} onChange={(event) => onChange((c) => void (c.textColor = (event.target.value || null) as 'dark' | null))}>
              <option value="">Standard</option>
              <option value="dark">Dark</option>
              <option value="light">Light (for dark tiles)</option>
            </select>
          </Field>
        </>
      }
    />
  );
}

/**
 * Home Page Builder — the customer Home page, top to bottom, as one
 * draft-and-publish document (lib/homeLayout.ts):
 *
 *   Top of the page   the background behind the header, search bar,
 *                     promotional area and top cards; whether the
 *                     promotional area and the cards show, and the cards'
 *                     size and spacing
 *   Sections          every section in the order customers see it: show or
 *                     hide, reorder (drag and drop, or ↑ / ↓), heading,
 *                     background, spacing, item count; ADD product shelves
 *                     and category sections (any number, each configured on
 *                     its own — homeShelfEditor.tsx), duplicate, remove
 *
 * Sections are identified by their stable id (never position or title).
 * Problems that would stop publishing (home-builder.ts homeLayoutProblems —
 * the same checks the server runs) are listed above the sections and on the
 * section concerned.
 *
 * The images and links themselves are banners (Banners & Cards page —
 * "Home — promotional area", "Home — top cards", "Home — food carousel"…);
 * category lists are set on Category Management. Nothing here is code: only
 * named colours or #RRGGBB, sizes within safe limits, known section kinds.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HOME_BACKGROUND_TYPES,
  HOME_CARD_COUNT_LIMITS,
  HOME_CARD_GAP_DP,
  HOME_CARD_HEIGHT_LIMITS,
  HOME_GRADIENT_DIRECTIONS,
  HOME_CUSTOM_SECTION_MAX,
  HOME_OVERLAY_OPACITY_MAX,
  HOME_REPEATABLE_SECTION_INFO,
  HOME_SPACING,
  HOME_SPACING_DP,
  HOME_TEXT_LIMITS,
  PRODUCT_SHELF_SOURCE_INFO,
  Permission,
  addHomeSection,
  canDuplicateHomeSection,
  categoryPlacementLimit,
  contentColor,
  countAddedSections,
  createHomeSection,
  duplicateHomeSection,
  homeLayoutProblems,
  homeSectionInfo,
  homeSectionTitle,
  isRepeatableSectionKind,
  moveHomeSection,
  newHomeSectionId,
  removeHomeSection,
  roleHasPermission,
  type AdminBannerDto,
  type HomeLayoutProblem,
  type HomeRepeatableSectionKind,
  type AdminCategoryOptionDto,
  type CategoryPlacementConfig,
  type CategoryPlacementKey,
  type HomeLayoutContent,
  type HomeSectionConfig,
} from '@shared';
import { Button, ErrorBanner, Field, Icon, Spinner, Surface, Toggle, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { imageSrc } from '@/lib/image';
import { validateImage, ACCEPTED_IMAGE_TYPES } from '@/lib/upload';
import { adminErrorMessage } from '@/lib/marketplace';
import { useAdminBanners } from '@/lib/content';
import { uploadHomeBackground, useCategoryOptions, useLayoutEditor, useShelfPreview } from '@/lib/homeLayout';
import { ColorPicker, DragHandle, MoveButtons, NoticeLine, PublishBar, backgroundCss, useDragReorder, type Notice } from './homeLayoutUi';
import { PlacementEditor, categoriesForLevel, placementCategories } from './CategoryDisplay';
import { CategorySectionEditor, ShelfEditor, categoryPathLabel } from './homeShelfEditor';

const SPACING_LABEL = { compact: 'Compact', normal: 'Normal', relaxed: 'Relaxed' } as const;
const BACKGROUND_TYPE_LABEL = { solid: 'Solid colour', gradient: 'Gradient', image: 'Image' } as const;
const DIRECTION_LABEL = { vertical: 'Top to bottom', horizontal: 'Left to right', diagonal: 'Diagonal' } as const;

export default function HomeBuilderPage() {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role ? roleHasPermission(role, Permission.CATALOG_WRITE) : false;
  const editor = useLayoutEditor();
  const banners = useAdminBanners();
  const categories = useCategoryOptions();
  const [notice, setNotice] = useState<Notice>(null);
  const [open, setOpen] = useState<string | null>(null);
  const drag = useDragReorder((from, to) => editor.update((l) => void Object.assign(l, moveHomeSection(l, from, to))));

  const liveBanners = useMemo(() => {
    const byPlacement = new Map<string, AdminBannerDto[]>();
    for (const banner of banners.data ?? []) {
      if (banner.visibility !== 'LIVE') continue;
      byPlacement.set(banner.placement, [...(byPlacement.get(banner.placement) ?? []), banner]);
    }
    return byPlacement;
  }, [banners.data]);

  if (editor.doc.isPending) return <Spinner label="Loading the Home page layout…" />;
  if (editor.doc.isError) return <ErrorBanner message={adminErrorMessage(editor.doc.error)} />;

  const { layout, update } = editor;
  const hero = layout.hero;
  const problems = homeLayoutProblems(editor.resolved);
  const categoryByPath = new Map((categories.data ?? []).map((option) => [option.path, option]));
  const categoryName = (path: string) => categoryByPath.get(path)?.name;
  const addedCount = countAddedSections(layout);

  /** A new shelf / category section at the end of the page, opened for editing. */
  const addSection = (kind: HomeRepeatableSectionKind) => {
    const id = newHomeSectionId(kind, layout);
    update((l) => {
      const next = addHomeSection(l, createHomeSection(kind, id));
      if (next) Object.assign(l, next);
    });
    setOpen(id);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-info-500/20 bg-info-50 px-4 py-3 text-sm text-gray-700">
        <Icon name="dashboard" className="mt-0.5 h-5 w-5 shrink-0 text-info-500" />
        <p>
          Arrange the customer Home page. Changes are a <span className="font-semibold">draft</span> until you publish — customers see only
          the published version, on their next refresh, with no app update. Images and links are banners on{' '}
          <Link to="/banners" className="font-semibold text-brand-700 underline">
            Banners &amp; Cards
          </Link>
          ; which categories show is set on{' '}
          <Link to="/category-display" className="font-semibold text-brand-700 underline">
            Category Management
          </Link>
          .
        </p>
      </div>

      <PublishBar editor={editor} canEdit={canEdit} onNotice={setNotice} />
      <NoticeLine notice={notice} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          {/* Top of the page ------------------------------------------------ */}
          <Surface className="space-y-4 p-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Top of the page</h2>
              <p className="text-sm text-gray-500">Behind the header, search bar, promotional area and top cards — from the very top of the screen.</p>
            </div>
            <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
              <Field label="Background">
                <select
                  className={inputClass}
                  value={hero.background.type}
                  onChange={(event) => update((l) => void (l.hero.background.type = event.target.value as HomeLayoutContent['hero']['background']['type']))}
                >
                  {HOME_BACKGROUND_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {BACKGROUND_TYPE_LABEL[type]}
                    </option>
                  ))}
                </select>
              </Field>
              {hero.background.type === 'gradient' && (
                <Field label="Gradient direction">
                  <select
                    className={inputClass}
                    value={hero.background.direction}
                    onChange={(event) => update((l) => void (l.hero.background.direction = event.target.value as 'vertical'))}
                  >
                    {HOME_GRADIENT_DIRECTIONS.map((direction) => (
                      <option key={direction} value={direction}>
                        {DIRECTION_LABEL[direction]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={hero.background.type === 'gradient' ? 'Top colour (also the header)' : 'Colour (also the header)'}>
                <ColorPicker label="Background colour" allowNone={false} value={hero.background.color} onChange={(value) => update((l) => void (l.hero.background.color = value))} />
              </Field>
              {hero.background.type === 'gradient' && (
                <Field label="Bottom colour">
                  <ColorPicker label="Gradient end colour" allowNone={false} value={hero.background.colorTo} onChange={(value) => update((l) => void (l.hero.background.colorTo = value))} />
                </Field>
              )}
              {hero.background.type === 'image' && (
                <>
                  <BackgroundImage
                    url={hero.background.imageUrl}
                    onChange={(url) => update((l) => void (l.hero.background.imageUrl = url))}
                    onNotice={setNotice}
                  />
                  <Field label="Tint over the image" hint="Keeps text readable on a busy image.">
                    <ColorPicker label="Tint colour" allowNone={false} value={hero.background.overlayColor} onChange={(value) => update((l) => void (l.hero.background.overlayColor = value))} />
                  </Field>
                  <Field label={`Tint strength: ${Math.round(hero.background.overlayOpacity * 100)}%`}>
                    <input
                      type="range"
                      min={0}
                      max={HOME_OVERLAY_OPACITY_MAX}
                      step={0.05}
                      value={hero.background.overlayOpacity}
                      onChange={(event) => update((l) => void (l.hero.background.overlayOpacity = Number(event.target.value)))}
                      className="w-full accent-brand-600"
                    />
                  </Field>
                </>
              )}
              <Field label="Space inside">
                <select className={inputClass} value={hero.padding} onChange={(event) => update((l) => void (l.hero.padding = event.target.value as 'normal'))}>
                  {HOME_SPACING.map((value) => (
                    <option key={value} value={value}>
                      {SPACING_LABEL[value]}
                    </option>
                  ))}
                </select>
              </Field>
            </fieldset>

            <div className="grid gap-4 border-t border-gray-100 pt-4 md:grid-cols-2">
              <div className="space-y-2">
                <Toggle label="Show the promotional area" checked={hero.promo.visible} disabled={!canEdit} onChange={(next) => update((l) => void (l.hero.promo.visible = next))} />
                <p className="text-xs text-gray-500">
                  {liveBanners.get('home_top')?.length ?? 0} live banner(s) in "Home — promotional area". With none live, the area is left out (no empty space).{' '}
                  <Link to="/banners" className="font-semibold text-brand-700 underline">
                    Manage
                  </Link>
                </p>
              </div>
              <div className="space-y-2">
                <Toggle label="Show the top cards" checked={hero.cards.visible} disabled={!canEdit} onChange={(next) => update((l) => void (l.hero.cards.visible = next))} />
                <p className="text-xs text-gray-500">
                  {liveBanners.get('home_cards')?.length ?? 0} live card(s) in "Home — top cards" (image, title, subtitle, colour and link per card).{' '}
                  <Link to="/banners" className="font-semibold text-brand-700 underline">
                    Manage
                  </Link>
                </p>
              </div>
            </div>
            {hero.cards.visible && (
              <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-4">
                <Field label="Cards in the row">
                  <select className={inputClass} value={hero.cards.maxItems} onChange={(event) => update((l) => void (l.hero.cards.maxItems = Number(event.target.value)))}>
                    {Array.from({ length: HOME_CARD_COUNT_LIMITS.max - HOME_CARD_COUNT_LIMITS.min + 1 }, (_, i) => HOME_CARD_COUNT_LIMITS.min + i).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Card height: ${hero.cards.height} dp`}>
                  <input
                    type="range"
                    min={HOME_CARD_HEIGHT_LIMITS.min}
                    max={HOME_CARD_HEIGHT_LIMITS.max}
                    step={4}
                    value={hero.cards.height}
                    onChange={(event) => update((l) => void (l.hero.cards.height = Number(event.target.value)))}
                    className="w-full accent-brand-600"
                  />
                </Field>
                <Field label="Corners">
                  <select className={inputClass} value={hero.cards.radius} onChange={(event) => update((l) => void (l.hero.cards.radius = event.target.value as 'lg'))}>
                    <option value="sm">Slightly rounded</option>
                    <option value="md">Rounded</option>
                    <option value="lg">Very rounded</option>
                  </select>
                </Field>
                <Field label="Gap between cards">
                  <select className={inputClass} value={hero.cards.gap} onChange={(event) => update((l) => void (l.hero.cards.gap = event.target.value as 'normal'))}>
                    <option value="tight">Tight</option>
                    <option value="normal">Normal</option>
                    <option value="wide">Wide</option>
                  </select>
                </Field>
              </fieldset>
            )}
          </Surface>

          {/* Sections -------------------------------------------------------- */}
          <Surface className="p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Sections</h2>
                <p className="text-sm text-gray-500">
                  In the order customers see them, below the top of the page — drag ⋮⋮ or use ↑ / ↓. A hidden section is skipped; one with nothing to
                  show is left out automatically.
                </p>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  {(['product_shelf', 'category_section'] as const).map((kind) => (
                    <Button key={kind} variant="soft" disabled={addedCount >= HOME_CUSTOM_SECTION_MAX} onClick={() => addSection(kind)}>
                      <Icon name="plus" className="h-4 w-4" /> {HOME_REPEATABLE_SECTION_INFO[kind].label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            {problems.length > 0 && (
              <div className="mb-3 rounded-xl border border-danger-500/30 bg-danger-50 px-3 py-2 text-sm text-danger-700" role="alert">
                <p className="font-semibold">Fix before publishing ({problems.length}):</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {problems.map((problem) => (
                    <li key={`${problem.field}:${problem.message}`}>
                      {problem.sectionId ? (
                        <button type="button" className="text-left underline" onClick={() => setOpen(problem.sectionId)}>
                          {problem.message}
                        </button>
                      ) : (
                        problem.message
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ol className="space-y-2">
              {layout.sections.map((section, index) => (
                <SectionRow
                  key={section.id}
                  section={section}
                  index={index}
                  count={layout.sections.length}
                  canEdit={canEdit}
                  open={open === section.id}
                  onToggleOpen={() => setOpen(open === section.id ? null : section.id)}
                  summary={sectionSummary(section, layout, liveBanners, categories.data ?? [], categoryName)}
                  problems={problems.filter((problem) => problem.sectionId === section.id)}
                  onChange={(change) => update((l) => change(l.sections.find((s) => s.id === section.id)!))}
                  onMove={(to) => update((l) => void Object.assign(l, moveHomeSection(l, index, to)))}
                  onDuplicate={
                    canDuplicateHomeSection(section) && addedCount < HOME_CUSTOM_SECTION_MAX
                      ? () => {
                          const id = newHomeSectionId(isRepeatableSectionKind(section.key) ? section.key : section.key === 'recently_added' || section.key === 'top_picks' ? 'product_shelf' : 'category_section', layout);
                          update((l) => {
                            const next = duplicateHomeSection(l, section.id, id);
                            if (next) Object.assign(l, next);
                          });
                          setOpen(id);
                          setNotice({ ok: true, text: 'Section duplicated — it is a separate section now; give it its own heading.' });
                        }
                      : null
                  }
                  onRemove={
                    isRepeatableSectionKind(section.key)
                      ? () => {
                          if (window.confirm(`Remove "${homeSectionTitle(section, categoryName)}" from the Home page? Its categories and products are not affected.`)) {
                            update((l) => void Object.assign(l, removeHomeSection(l, section.id)));
                          }
                        }
                      : null
                  }
                  dragHandle={canEdit ? drag.handleProps(index) : null}
                  dropProps={drag.dropProps(index)}
                  dropTarget={drag.over === index && drag.dragging !== index}
                  categoryName={categoryName}
                  layout={layout}
                  categoryOptions={categories.data ?? []}
                  onPlacement={(key, change) => update((l) => change(l.categoryPlacements[key]))}
                />
              ))}
            </ol>
          </Surface>
        </div>

        <div className="xl:sticky xl:top-24 xl:self-start">
          <HomePreview layout={editor.resolved} banners={liveBanners} categories={categories.data ?? []} />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function BackgroundImage({ url, onChange, onNotice }: { url: string | null; onChange: (url: string | null) => void; onNotice: (notice: Notice) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Field label="Background image" hint="Wide image, at least 600 px; stored as an optimised WebP.">
      <div className="flex items-center gap-3">
        {url && <img src={imageSrc(url)} alt="" className="h-14 w-24 rounded-lg border border-gray-200 object-cover" />}
        <label className="cursor-pointer rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          {busy ? 'Uploading…' : url ? 'Replace' : 'Upload'}
          <input
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            className="sr-only"
            disabled={busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const problem = validateImage(file);
              if (problem) return onNotice({ ok: false, text: problem });
              setBusy(true);
              try {
                onChange(await uploadHomeBackground(file));
                onNotice({ ok: true, text: 'Image uploaded — save the draft to keep it.' });
              } catch (error) {
                onNotice({ ok: false, text: adminErrorMessage(error) });
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {url && (
          <Button variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
    </Field>
  );
}

function sectionSummary(
  section: HomeSectionConfig,
  layout: HomeLayoutContent,
  banners: Map<string, AdminBannerDto[]>,
  options: AdminCategoryOptionDto[],
  categoryName: (path: string) => string | undefined,
): string {
  if (section.shelf) {
    const shelf = section.shelf;
    const scope = shelf.categoryPaths.length ? shelf.categoryPaths.map((path) => categoryName(path) ?? path).join(', ') : 'whole catalogue';
    const picked = shelf.source === 'manual' ? ` · ${shelf.productIds.length} chosen${shelf.fillFromScope ? ' + top-up' : ''}` : '';
    return `${PRODUCT_SHELF_SOURCE_INFO[shelf.source].label} · ${scope}${picked} · up to ${shelf.count} · ${shelf.layout === 'grid' ? `grid of ${shelf.columns}` : 'scrolling row'}`;
  }
  if (section.categories) {
    const config = section.categories;
    const shown = categoriesForLevel(config.level, config, layout.categoryStyles, options).length;
    return `${config.mode === 'manual' ? 'Chosen' : 'Automatic'} · ${shown} categor${shown === 1 ? 'y' : 'ies'} · ${config.layout === 'grid' ? `${config.columns ?? 'auto'} per row` : 'one row'}`;
  }
  const info = homeSectionInfo(section.key);
  if (info.categoryPlacement) {
    const placement = layout.categoryPlacements[info.categoryPlacement];
    const shown = placementCategories(info.categoryPlacement, placement, layout.categoryStyles, options).length;
    return `${placement.mode === 'manual' ? 'Chosen' : 'Automatic'} · ${shown} categor${shown === 1 ? 'y' : 'ies'} · ${placement.columns ?? 'auto'} per row`;
  }
  if (info.bannerPlacement) {
    const live = banners.get(info.bannerPlacement)?.length ?? 0;
    const limit = info.countLimits ? section.maxItems ?? info.countLimits.default : null;
    return `${live} live banner(s)${limit ? ` · shows up to ${limit}` : ''}`;
  }
  return info.hint;
}

function SectionRow({
  section,
  index,
  count,
  canEdit,
  open,
  onToggleOpen,
  summary,
  problems,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  dragHandle,
  dropProps,
  dropTarget,
  categoryName,
  layout,
  categoryOptions,
  onPlacement,
}: {
  section: HomeSectionConfig;
  index: number;
  count: number;
  canEdit: boolean;
  open: boolean;
  onToggleOpen: () => void;
  summary: string;
  problems: HomeLayoutProblem[];
  onChange: (change: (section: HomeSectionConfig) => void) => void;
  onMove: (to: number) => void;
  /** Null = this section cannot be duplicated. */
  onDuplicate: (() => void) | null;
  /** Null = a built-in section (hide it instead). */
  onRemove: (() => void) | null;
  dragHandle: ReturnType<ReturnType<typeof useDragReorder>['handleProps']> | null;
  dropProps: ReturnType<ReturnType<typeof useDragReorder>['dropProps']>;
  dropTarget: boolean;
  categoryName: (path: string) => string | undefined;
  layout: HomeLayoutContent;
  categoryOptions: AdminCategoryOptionDto[];
  onPlacement: (key: CategoryPlacementKey, change: (placement: CategoryPlacementConfig) => void) => void;
}) {
  const info = homeSectionInfo(section.key);
  const added = isRepeatableSectionKind(section.key);
  const name = homeSectionTitle(section, categoryName);
  return (
    <li
      {...dropProps}
      className={`rounded-xl border p-2.5 ${dropTarget ? 'border-brand-500 ring-2 ring-brand-200' : problems.length ? 'border-danger-500/40' : section.visible ? 'border-gray-200' : 'border-dashed border-gray-300 bg-gray-50'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        {dragHandle && <DragHandle label={name} {...dragHandle} />}
        {canEdit && <MoveButtons index={index} count={count} onMove={onMove} label={name} />}
        <span className="h-8 w-8 shrink-0 rounded-lg border border-gray-200" style={{ background: contentColor(section.background, '#FFFFFF') }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900">
            {index + 1}. {name}
            <span className="ml-2 text-xs font-normal text-gray-500">({added ? `${info.label} · added` : info.label})</span>
          </p>
          <p className="text-xs text-gray-500">{summary}</p>
          {problems.map((problem) => (
            <p key={problem.field} className="text-xs font-medium text-danger-600">
              {problem.message}
            </p>
          ))}
        </div>
        <Toggle label={section.visible ? 'Shown' : 'Hidden'} checked={section.visible} disabled={!canEdit} onChange={(next) => onChange((s) => void (s.visible = next))} />
        <Button variant="ghost" onClick={onToggleOpen}>
          <Icon name="edit" className="h-4 w-4" /> {open ? 'Close' : 'Edit'}
        </Button>
        {canEdit && onDuplicate && (
          <Button variant="ghost" onClick={onDuplicate} title={added ? 'Duplicate this section' : 'Make an added section with the same settings'}>
            <Icon name="plus" className="h-4 w-4" /> Duplicate
          </Button>
        )}
        {canEdit && onRemove && (
          <Button variant="ghost" onClick={onRemove} aria-label={`Remove ${name}`}>
            <Icon name="trash" className="h-4 w-4" /> Remove
          </Button>
        )}
      </div>
      {open && (
        <fieldset disabled={!canEdit} className="mt-3 grid gap-3 border-t border-gray-100 pt-3 md:grid-cols-2">
          <p className="text-xs text-gray-500 md:col-span-2">{info.hint}</p>
          {info.titleEditable && (
            <>
              <Field label="Heading" hint={added && section.key === 'product_shelf' ? 'Required for a product shelf — customers see it above the products.' : 'Empty = the standard heading.'}>
                <input
                  className={inputClass}
                  maxLength={HOME_TEXT_LIMITS.title}
                  value={section.title ?? ''}
                  placeholder={added ? 'e.g. Fresh vegetables' : info.label}
                  onChange={(event) => onChange((s) => void (s.title = event.target.value || null))}
                />
              </Field>
              <Field label="Subtitle">
                <input
                  className={inputClass}
                  maxLength={HOME_TEXT_LIMITS.subtitle}
                  value={section.subtitle ?? ''}
                  onChange={(event) => onChange((s) => void (s.subtitle = event.target.value || null))}
                />
              </Field>
            </>
          )}
          <Field label="Section background">
            <ColorPicker label={`${info.label} background`} value={section.background} onChange={(value) => onChange((s) => void (s.background = value))} />
          </Field>
          <Field label="Space above and below">
            <select className={inputClass} value={section.spacing} onChange={(event) => onChange((s) => void (s.spacing = event.target.value as 'normal'))}>
              {HOME_SPACING.map((value) => (
                <option key={value} value={value}>
                  {SPACING_LABEL[value]}
                </option>
              ))}
            </select>
          </Field>
          {info.countLimits && (
            <Field label={info.bannerPlacement ? 'Cards shown' : 'Products shown'} hint={`${info.countLimits.min}–${info.countLimits.max}; ${info.countLimits.default} by default.`}>
              <input
                type="number"
                className={inputClass}
                min={info.countLimits.min}
                max={info.countLimits.max}
                value={section.maxItems ?? info.countLimits.default}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) onChange((s) => void (s.maxItems = Math.min(info.countLimits!.max, Math.max(info.countLimits!.min, Math.round(value)))));
                }}
              />
            </Field>
          )}
        </fieldset>
      )}
      {open && section.shelf && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <ShelfEditor sectionId={section.id} shelf={section.shelf} options={categoryOptions} canEdit={canEdit} onChange={(change) => onChange((s) => change(s.shelf!))} />
        </div>
      )}
      {open && section.categories && (
        <div className="mt-3">
          <CategorySectionEditor
            config={section.categories}
            styles={layout.categoryStyles}
            options={categoryOptions}
            canEdit={canEdit}
            onChange={(change) => onChange((s) => change(s.categories!))}
          />
        </div>
      )}
      {open && info.categoryPlacement && (
        <div className="mt-3">
          {/* The same placement editor as Category Management — one setting, edited from either page. */}
          <PlacementEditor
            placementKey={info.categoryPlacement}
            layout={layout}
            options={categoryOptions}
            canEdit={canEdit}
            onChange={(change) => onPlacement(info.categoryPlacement!, change)}
          />
          <p className="mt-2 text-xs text-gray-500">
            Display names, colours and hiding a category everywhere: <Link to="/category-display" className="font-semibold text-brand-700 underline">Category Management → Categories</Link>.
          </p>
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Phone preview — an approximation of the app's Home with the draft applied   */
/* -------------------------------------------------------------------------- */

const PHONE_WIDTH = 360;
const CARD_RADIUS = { sm: 6, md: 10, lg: 16 } as const;

function HomePreview({ layout, banners, categories }: { layout: HomeLayoutContent; banners: Map<string, AdminBannerDto[]>; categories: AdminCategoryOptionDto[] }) {
  const hero = layout.hero;
  const promo = hero.promo.visible ? (banners.get('home_top') ?? []).slice(0, 1) : [];
  const cards = hero.cards.visible ? (banners.get('home_cards') ?? []).slice(0, hero.cards.maxItems) : [];
  const pad = HOME_SPACING_DP[hero.padding];
  const gap = HOME_CARD_GAP_DP[hero.cards.gap];
  const cardWidth = cards.length ? (PHONE_WIDTH - 32 - gap * (cards.length - 1)) / cards.length : 0;

  return (
    <div className="mx-auto overflow-hidden rounded-[28px] border-8 border-gray-900 bg-white shadow-xl" style={{ width: PHONE_WIDTH + 16 }}>
      <div className="max-h-[720px] overflow-y-auto" style={{ width: PHONE_WIDTH }}>
        <div style={{ ...backgroundCss(hero.background, imageSrc), paddingBottom: pad }}>
          <div className="flex items-center gap-2 px-4 pb-2 pt-4 text-xs">
            <span className="font-semibold text-gray-900">Delivering to · Home</span>
            <span className="ml-auto text-brand-600">🔔 👤</span>
          </div>
          <div className="mx-4 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-400">Search for “atta”, “milk”…</div>
          {promo.map((banner) => (
            <img
              key={banner.id}
              src={imageSrc(banner.imageUrl)}
              alt={banner.title ?? ''}
              className="mx-4 mt-3 rounded-xl object-cover"
              style={{ width: PHONE_WIDTH - 32, aspectRatio: `${banner.imageWidth} / ${banner.imageHeight}` }}
            />
          ))}
          {cards.length > 0 && (
            <div className="mx-4 mt-3 flex" style={{ gap }}>
              {cards.map((card) => (
                <div
                  key={card.id}
                  className="relative overflow-hidden"
                  style={{ width: cardWidth, height: hero.cards.height, borderRadius: CARD_RADIUS[hero.cards.radius], background: contentColor(card.layout?.background ?? 'white', '#FFFFFF') }}
                >
                  <img src={imageSrc(card.imageUrl)} alt="" className={`absolute inset-0 h-full w-full ${card.layout?.fit === 'contain' ? 'object-contain' : 'object-cover'}`} />
                  <div className={`absolute inset-x-0 top-0 p-1.5 ${card.layout?.textTone === 'light' ? 'text-white' : 'text-gray-900'}`}>
                    <p className="text-[11px] font-bold leading-tight">{card.title}</p>
                    {card.subtitle && <p className="text-[9px] leading-tight opacity-80">{card.subtitle}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {layout.sections
          .filter((section) => section.visible)
          .map((section) => (
            <PreviewSection key={section.id} section={section} layout={layout} banners={banners} categories={categories} />
          ))}
        <p className="py-4 text-center text-[10px] text-gray-400">Aadione · footer</p>
      </div>
      <p className="bg-gray-900 py-1 text-center text-[10px] text-gray-300">Preview — approximate; the app draws the real page</p>
    </div>
  );
}

function PreviewSection({ section, layout, banners, categories }: { section: HomeSectionConfig; layout: HomeLayoutContent; banners: Map<string, AdminBannerDto[]>; categories: AdminCategoryOptionDto[] }) {
  if (section.shelf) return <PreviewShelf section={section} categories={categories} />;
  const info = homeSectionInfo(section.key);
  const space = HOME_SPACING_DP[section.spacing];
  const wrap = (body: React.ReactNode) => (
    <div style={{ background: contentColor(section.background, 'transparent'), paddingTop: space / 2, paddingBottom: space / 2 }}>
      <div className="px-4">
        <p className="text-[13px] font-bold text-gray-900">{homeSectionTitle(section)}</p>
        {section.subtitle && <p className="text-[10px] text-gray-500">{section.subtitle}</p>}
      </div>
      <div className="mt-1.5">{body}</div>
    </div>
  );

  if (info.categoryPlacement || section.categories) {
    const placement = section.categories ?? layout.categoryPlacements[info.categoryPlacement!];
    const columns = placement.columns ?? 4;
    const all = section.categories
      ? categoriesForLevel(section.categories.level, section.categories, layout.categoryStyles, categories)
      : placementCategories(info.categoryPlacement!, placement, layout.categoryStyles, categories);
    const list = all.slice(0, categoryPlacementLimit(placement, columns));
    if (list.length === 0) return null;
    return wrap(
      <div className={placement.layout === 'row' ? 'flex gap-2 overflow-x-auto px-4' : 'grid gap-2 px-4'} style={placement.layout === 'row' ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {list.map((category) => (
          <div key={category.path} className={`text-center ${placement.layout === 'row' ? 'w-16 shrink-0' : ''}`}>
            <div
              className={`mx-auto aspect-square w-full overflow-hidden ${placement.tileShape === 'circle' ? 'rounded-full' : placement.tileShape === 'square' ? 'rounded-none' : 'rounded-xl'}`}
              style={{ background: contentColor(category.tileBackground ?? placement.tileBackground, '#F1F9F3') }}
            >
              {category.imageUrl && <img src={imageSrc(category.imageUrl)} alt="" className={`h-full w-full ${placement.imageFit === 'contain' ? 'object-contain' : 'object-cover'}`} />}
            </div>
            <p className="mt-0.5 truncate text-[9px] font-medium text-gray-700">{category.label}</p>
          </div>
        ))}
      </div>,
    );
  }

  if (info.bannerPlacement) {
    const limit = info.countLimits ? section.maxItems ?? info.countLimits.default : 10;
    const list = (banners.get(info.bannerPlacement) ?? []).slice(0, limit);
    if (list.length === 0) {
      return section.key === 'food_carousel' ? wrap(<div className="mx-4 rounded-xl bg-amber-50 px-3 py-4 text-[11px] text-amber-800">Standard food banner (no live food carousel cards)</div>) : null;
    }
    return wrap(
      <div className="flex gap-2 overflow-x-auto px-4">
        {list.map((banner) => (
          <img
            key={banner.id}
            src={imageSrc(banner.imageUrl)}
            alt={banner.title ?? ''}
            className="shrink-0 rounded-xl object-cover"
            style={{ width: section.key === 'food_carousel' ? PHONE_WIDTH * 0.72 : PHONE_WIDTH - 32, aspectRatio: `${banner.imageWidth} / ${banner.imageHeight}` }}
          />
        ))}
      </div>,
    );
  }

  return wrap(
    <div className="flex gap-2 overflow-hidden px-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 w-24 shrink-0 rounded-xl border border-gray-100 bg-gray-50" />
      ))}
    </div>,
  );
}

/** A product shelf in the phone preview: the products the server would give customers now. */
function PreviewShelf({ section, categories }: { section: HomeSectionConfig; categories: AdminCategoryOptionDto[] }) {
  const shelf = section.shelf!;
  const preview = useShelfPreview(section.id, shelf);
  const products = preview.data ?? [];
  if (products.length === 0) return null;
  const byPath = new Map(categories.map((option) => [option.path, option]));
  const space = HOME_SPACING_DP[section.spacing];
  const grid = shelf.layout === 'grid';
  return (
    <div style={{ background: contentColor(section.background, 'transparent'), paddingTop: space / 2, paddingBottom: space / 2 }}>
      <div className="px-4">
        <p className="text-[13px] font-bold text-gray-900">{homeSectionTitle(section, (path) => byPath.get(path)?.name ?? categoryPathLabel(path, byPath))}</p>
        {section.subtitle && <p className="text-[10px] text-gray-500">{section.subtitle}</p>}
      </div>
      <div className={`mt-1.5 px-4 ${grid ? `grid ${shelf.columns === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-2` : 'flex gap-2 overflow-x-auto'}`}>
        {products.map((product) => (
          <div key={product.id} className={`rounded-lg border border-gray-100 bg-white p-1 ${grid ? '' : 'shrink-0'}`} style={grid ? undefined : { width: { compact: 92, regular: 104, large: 120 }[shelf.cardSize] }}>
            <div className="aspect-square overflow-hidden rounded bg-gray-50">{product.imageUrl && <img src={imageSrc(product.imageUrl)} alt="" className="h-full w-full object-contain" />}</div>
            <p className="mt-0.5 line-clamp-2 text-[9px] leading-tight text-gray-800">{product.name}</p>
          </div>
        ))}
      </div>
      {shelf.viewAll.type !== 'none' && <p className="mx-4 mt-1.5 rounded-lg border border-gray-200 py-1 text-center text-[10px] font-semibold text-gray-700">See All</p>}
    </div>
  );
}

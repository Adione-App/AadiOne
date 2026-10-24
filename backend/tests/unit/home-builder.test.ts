/**
 * Home Page Builder — the shared contract for ADDED sections (product
 * shelves, category sections): resolveHomeLayout's handling of them, the
 * editing operations the Admin Panel uses (add / duplicate / remove / move),
 * the View All rule and the publish checks (shared/home-layout.ts,
 * shared/home-builder.ts). Pure — no database.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOME_LAYOUT,
  HOME_CUSTOM_SECTION_MAX,
  HOME_SECTION_KEYS,
  PRODUCT_SHELF_COUNT_LIMITS,
  PRODUCT_SHELF_PICK_MAX,
  addHomeSection,
  canDuplicateHomeSection,
  createHomeSection,
  duplicateHomeSection,
  homeLayoutProblems,
  homeLayoutReferences,
  homeSectionTitle,
  moveHomeSection,
  newHomeSectionId,
  productShelfViewAllOptions,
  productShelfViewAllProblem,
  removeHomeSection,
  resolveHomeLayout,
  type HomeLayoutContent,
  type ProductShelfConfig,
} from '../../src/shared';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const base = (): HomeLayoutContent => resolveHomeLayout(DEFAULT_HOME_LAYOUT);
const shelf = (overrides: Partial<ProductShelfConfig> = {}) => createHomeSection('product_shelf', 'shelf-grocery', { title: 'Grocery', shelf: overrides }).shelf!;
const ids = (layout: HomeLayoutContent) => layout.sections.map((section) => section.id);

describe('resolveHomeLayout — added sections', () => {
  it('gives built-in sections their key as a stable id; an older document without ids still resolves', () => {
    const old = resolveHomeLayout({ sections: [{ key: 'recently_added', visible: false }, { key: 'top_categories' }] });
    expect(old.sections[0]).toMatchObject({ id: 'recently_added', visible: false });
    expect(ids(old).indexOf('recently_added')).toBeLessThan(ids(old).indexOf('top_categories'));
    // Every built-in section is still there, once.
    expect(new Set(ids(old))).toEqual(new Set(HOME_SECTION_KEYS));
    expect(old.sections.every((section) => section.shelf === null && section.categories === null)).toBe(true);
  });

  it('keeps added sections in place, with their own settings clamped to the safe limits', () => {
    const layout = resolveHomeLayout({
      sections: [
        ...base().sections.slice(0, 1),
        {
          id: 'shelf-veg',
          key: 'product_shelf',
          title: 'Vegetables',
          shelf: { source: 'latest', categoryPaths: ['vegetables-fruits/vegetables', 'NOT A PATH'], count: 999, layout: 'grid', columns: 7, cardSize: 'huge' },
        },
        { id: 'cats-explore', key: 'category_section', categories: { mode: 'manual', paths: ['grocery', 'grocery/rice'], maxItems: 0, level: 'sub', textColor: 'neon' } },
        ...base().sections.slice(1),
      ],
    });
    expect(ids(layout).slice(0, 3)).toEqual(['top_categories', 'shelf-veg', 'cats-explore']);
    const veg = layout.sections[1]!;
    expect(veg.shelf).toMatchObject({
      source: 'latest',
      categoryPaths: ['vegetables-fruits/vegetables'],
      count: PRODUCT_SHELF_COUNT_LIMITS.max,
      layout: 'grid',
      columns: 2,
      cardSize: 'regular',
    });
    expect(layout.sections[2]!.categories).toMatchObject({ mode: 'manual', paths: ['grocery', 'grocery/rice'], maxItems: 1, level: 'sub', textColor: null });
  });

  it('skips unknown types, broken or duplicate ids, built-in ids on added sections, and anything past the maximum', () => {
    const many = Array.from({ length: HOME_CUSTOM_SECTION_MAX + 5 }, (_, index) => ({ id: `shelf-${index}`, key: 'product_shelf' }));
    const layout = resolveHomeLayout({
      sections: [
        { id: 'html-1', key: 'html_block', html: '<script>alert(1)</script>' },
        { key: 'product_shelf' },
        { id: 'X', key: 'product_shelf' },
        { id: 'top_categories', key: 'product_shelf' },
        { id: 'shelf-a', key: 'product_shelf' },
        { id: 'shelf-a', key: 'category_section' },
        ...many,
      ],
    });
    const added = layout.sections.filter((section) => section.key === 'product_shelf' || section.key === 'category_section');
    expect(added).toHaveLength(HOME_CUSTOM_SECTION_MAX);
    expect(added[0]!.id).toBe('shelf-a');
    expect(layout.sections.some((section) => (section.key as string) === 'html_block')).toBe(false);
  });

  it('keeps hand-picked products once each, lower-cased, at most the maximum', () => {
    const picks = [P1, P1.toUpperCase(), 'not-a-uuid', P2, ...Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)];
    const resolved = resolveHomeLayout({ sections: [{ id: 'shelf-picks', key: 'product_shelf', shelf: { source: 'manual', productIds: picks } }] });
    const productIds = resolved.sections.find((section) => section.id === 'shelf-picks')!.shelf!.productIds;
    expect(productIds.slice(0, 2)).toEqual([P1, P2]);
    expect(productIds).toHaveLength(PRODUCT_SHELF_PICK_MAX);
  });
});

describe('View All must fit the shelf', () => {
  it('a category destination must contain every category of the shelf', () => {
    expect(productShelfViewAllProblem(shelf({ categoryPaths: ['grocery'], viewAll: { type: 'category', path: 'grocery' } }))).toBeNull();
    // Main category containing all of the shelf's subcategories.
    expect(productShelfViewAllProblem(shelf({ categoryPaths: ['grocery/rice', 'grocery/oil'], viewAll: { type: 'category', path: 'grocery' } }))).toBeNull();
    // Unrelated, narrower, or a shelf of the whole catalogue: refused.
    expect(productShelfViewAllProblem(shelf({ categoryPaths: ['grocery'], viewAll: { type: 'category', path: 'kitchen' } }))).toMatch(/own category/);
    expect(productShelfViewAllProblem(shelf({ categoryPaths: ['grocery'], viewAll: { type: 'category', path: 'grocery/rice' } }))).toMatch(/own category/);
    expect(productShelfViewAllProblem(shelf({ categoryPaths: ['grocery', 'vegetables-fruits'], viewAll: { type: 'category', path: 'grocery' } }))).toMatch(/own category/);
    expect(productShelfViewAllProblem(shelf({ categoryPaths: [], viewAll: { type: 'category', path: 'grocery' } }))).toMatch(/only when/);
  });

  it('the latest / best-selling listings fit only those shelves of the whole catalogue', () => {
    expect(productShelfViewAllProblem(shelf({ source: 'latest', viewAll: { type: 'latest', path: null } }))).toBeNull();
    expect(productShelfViewAllProblem(shelf({ source: 'bestselling', viewAll: { type: 'bestselling', path: null } }))).toBeNull();
    expect(productShelfViewAllProblem(shelf({ source: 'random', viewAll: { type: 'latest', path: null } }))).not.toBeNull();
    expect(productShelfViewAllProblem(shelf({ source: 'latest', categoryPaths: ['grocery'], viewAll: { type: 'latest', path: null } }))).not.toBeNull();
  });

  it('offers only destinations that fit', () => {
    expect(productShelfViewAllOptions(shelf({ categoryPaths: ['grocery/rice'] }))).toEqual([
      { type: 'category', path: 'grocery/rice' },
      { type: 'category', path: 'grocery' },
    ]);
    expect(productShelfViewAllOptions(shelf({ categoryPaths: ['grocery', 'kitchen'] }))).toEqual([]);
    expect(productShelfViewAllOptions(shelf({ source: 'random', categoryPaths: [] }))).toEqual([]);
    expect(productShelfViewAllOptions(shelf({ source: 'latest', categoryPaths: [] }))).toEqual([{ type: 'latest', path: null }]);
  });
});

describe('editing operations', () => {
  it('adds a section with a fresh id and sensible defaults; ids never repeat', () => {
    let layout = base();
    const first = newHomeSectionId('product_shelf', layout, () => 'abc123');
    layout = addHomeSection(layout, createHomeSection('product_shelf', first, { title: 'Grocery', shelf: { source: 'random', categoryPaths: ['grocery'] } }), 1)!;
    expect(layout.sections[1]).toMatchObject({ id: 'shelf-abc123', key: 'product_shelf', visible: true });
    // A single-category shelf opens its category from View All by default.
    expect(layout.sections[1]!.shelf!.viewAll).toEqual({ type: 'category', path: 'grocery' });
    const second = newHomeSectionId('product_shelf', layout, () => 'abc123');
    expect(second).not.toBe(first);
  });

  it('moves sections (drag and drop / up-down) and the order survives a save (resolve)', () => {
    let layout = addHomeSection(base(), createHomeSection('product_shelf', 'shelf-grocery', { title: 'Grocery' }))!;
    const last = layout.sections.length - 1;
    layout = moveHomeSection(layout, last, 0);
    expect(layout.sections[0]!.id).toBe('shelf-grocery');
    const saved = resolveHomeLayout(JSON.parse(JSON.stringify(layout)));
    expect(ids(saved)).toEqual(ids(layout));
    // Out-of-range moves change nothing.
    expect(moveHomeSection(layout, 0, 999)).toBe(layout);
  });

  it('duplicates into an independent section with a new id; editing the copy leaves the original alone', () => {
    const layout = addHomeSection(base(), createHomeSection('product_shelf', 'shelf-grocery', { title: 'Grocery', shelf: { source: 'random', categoryPaths: ['grocery'], count: 10 } }))!;
    const copied = duplicateHomeSection(layout, 'shelf-grocery', 'shelf-grocery2')!;
    const index = copied.sections.findIndex((section) => section.id === 'shelf-grocery');
    expect(copied.sections[index + 1]).toMatchObject({ id: 'shelf-grocery2', title: 'Grocery (copy)' });
    copied.sections[index + 1]!.shelf!.count = 15;
    expect(copied.sections[index]!.shelf!.count).toBe(10);
    // An id already in use is refused.
    expect(duplicateHomeSection(layout, 'shelf-grocery', 'top_categories')).toBeNull();
  });

  it('duplicating a built-in list makes an added section with the same settings', () => {
    const layout = base();
    layout.categoryPlacements.home_top = { ...layout.categoryPlacements.home_top, mode: 'manual', paths: ['grocery'], columns: 5 };
    const cats = duplicateHomeSection(layout, 'top_categories', 'cats-copy')!.sections.find((section) => section.id === 'cats-copy')!;
    expect(cats).toMatchObject({ key: 'category_section', categories: { mode: 'manual', paths: ['grocery'], columns: 5, level: 'top' } });
    const latest = duplicateHomeSection(layout, 'recently_added', 'shelf-latest')!.sections.find((section) => section.id === 'shelf-latest')!;
    expect(latest.shelf).toMatchObject({ source: 'latest', categoryPaths: [], viewAll: { type: 'latest', path: null } });
    expect(canDuplicateHomeSection(layout.sections.find((section) => section.id === 'offers')!)).toBe(false);
  });

  it('removing an added section drops it; a built-in section is hidden instead (it always exists once)', () => {
    let layout = addHomeSection(base(), createHomeSection('category_section', 'cats-x'))!;
    layout = removeHomeSection(layout, 'cats-x');
    expect(ids(layout)).not.toContain('cats-x');
    layout = removeHomeSection(layout, 'top_picks');
    expect(layout.sections.find((section) => section.id === 'top_picks')).toMatchObject({ visible: false });
  });

  it('refuses more than the maximum number of added sections', () => {
    let layout = base();
    for (let i = 0; i < HOME_CUSTOM_SECTION_MAX; i += 1) layout = addHomeSection(layout, createHomeSection('category_section', `cats-${i}xx`))!;
    expect(addHomeSection(layout, createHomeSection('category_section', 'cats-onemore'))).toBeNull();
  });
});

describe('publish checks', () => {
  it('names what to fix: a shelf heading, chosen products, a fitting View All, chosen categories, duplicate headings', () => {
    let layout = base();
    layout = addHomeSection(layout, createHomeSection('product_shelf', 'shelf-a', { shelf: { source: 'manual', viewAll: { type: 'category', path: 'kitchen' } } }))!;
    layout = addHomeSection(layout, createHomeSection('category_section', 'cats-a', { title: 'Explore' }))!;
    layout = addHomeSection(layout, createHomeSection('category_section', 'cats-b', { title: 'explore', categories: { mode: 'auto' } }))!;
    const problems = homeLayoutProblems(layout);
    expect(problems.map((problem) => problem.field)).toEqual([
      'sections.shelf-a.title',
      'sections.shelf-a.shelf.productIds',
      'sections.shelf-a.shelf.viewAll',
      'sections.cats-a.categories.paths',
      'sections.cats-b.title',
    ]);
    expect(homeLayoutProblems(base())).toEqual([]);
  });

  it('lists every referenced category and hand-picked product (for the live checks)', () => {
    const layout = addHomeSection(
      base(),
      createHomeSection('product_shelf', 'shelf-a', {
        title: 'Fruits',
        shelf: { source: 'manual', categoryPaths: ['vegetables-fruits/fruits'], productIds: [P1, P2], viewAll: { type: 'category', path: 'vegetables-fruits' } },
      }),
    )!;
    const refs = homeLayoutReferences(layout);
    expect([...refs.categoryPaths].sort()).toEqual(['vegetables-fruits', 'vegetables-fruits/fruits']);
    expect([...refs.productIds]).toEqual([P1, P2]);
  });

  it('a shelf without a heading is described by what it shows', () => {
    const section = createHomeSection('product_shelf', 'shelf-x', { shelf: { source: 'latest', categoryPaths: ['grocery'] } });
    expect(homeSectionTitle(section, (path) => (path === 'grocery' ? 'Grocery' : undefined))).toBe('Latest in Grocery');
  });
});

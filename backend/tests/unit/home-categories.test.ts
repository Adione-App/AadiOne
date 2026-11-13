/**
 * Home page main categories (src/shared/home-categories.ts): the ONE place
 * the order / visibility / featured / new-category rules live — used by
 * GET /home, the admin list and the Admin Panel alike.
 */

import { describe, expect, it } from 'vitest';
import {
  arrangeMainCategories,
  homeMainCategoriesProblem,
  readHomeMainCategories,
  type HomeMainCategoriesConfig,
} from '../../src/shared';

const live = ['grocery', 'vegetables-fruits', 'electronics', 'clothes', 'ice-cream'];
const arrange = (config: HomeMainCategoriesConfig | null, legacy: string[] = [], items = live) =>
  arrangeMainCategories(items, (path) => path, config, legacy);
const shown = (config: HomeMainCategoriesConfig | null, legacy: string[] = [], items = live) =>
  arrange(config, legacy, items).filter((entry) => entry.visible).map((entry) => entry.path);

const config = (patch: Partial<HomeMainCategoriesConfig> = {}): HomeMainCategoriesConfig => ({
  order: live,
  hidden: [],
  featured: [],
  newCategoriesVisible: true,
  ...patch,
});

describe('arrangeMainCategories', () => {
  it('shows exactly the visible categories in the saved order (the example from the brief)', () => {
    const saved = config({
      order: ['grocery', 'vegetables-fruits', 'electronics', 'clothes', 'ice-cream'],
      hidden: ['grocery', 'electronics'],
    });
    expect(shown(saved)).toEqual(['vegetables-fruits', 'clothes', 'ice-cream']);
    // Hidden ones keep their place in the full list (the admin's screen).
    expect(arrange(saved).map((entry) => [entry.path, entry.visible])).toEqual([
      ['grocery', false],
      ['vegetables-fruits', true],
      ['electronics', false],
      ['clothes', true],
      ['ice-cream', true],
    ]);
  });

  it('follows a reorder exactly, and showing a category again puts it back in its place', () => {
    const reordered = config({ order: ['ice-cream', 'clothes', 'grocery', 'vegetables-fruits', 'electronics'], hidden: ['clothes'] });
    expect(shown(reordered)).toEqual(['ice-cream', 'grocery', 'vegetables-fruits', 'electronics']);
    expect(shown({ ...reordered, hidden: [] })).toEqual(['ice-cream', 'clothes', 'grocery', 'vegetables-fruits', 'electronics']);
  });

  it('appends a category created after the save, shown or hidden by the rule for new ones, without touching the saved ones', () => {
    const items = [...live, 'toys'];
    const saved = config({ order: ['clothes', 'grocery', 'vegetables-fruits', 'electronics', 'ice-cream'], hidden: ['electronics'] });

    const arranged = arrange(saved, [], items);
    expect(arranged.at(-1)).toMatchObject({ path: 'toys', isNew: true, visible: true, featured: false });
    expect(arranged.filter((entry) => !entry.isNew).map((entry) => [entry.path, entry.visible])).toEqual([
      ['clothes', true],
      ['grocery', true],
      ['vegetables-fruits', true],
      ['electronics', false],
      ['ice-cream', true],
    ]);

    expect(arrange({ ...saved, newCategoriesVisible: false }, [], items).at(-1)).toMatchObject({ path: 'toys', isNew: true, visible: false });
    expect(shown({ ...saved, newCategoriesVisible: false }, [], items)).not.toContain('toys');
  });

  it('skips a saved category that is gone right now (no gap) and restores it in place when it returns', () => {
    const saved = config({ order: ['clothes', 'grocery', 'ice-cream'], hidden: [], featured: ['grocery'] });
    const withoutGrocery = live.filter((path) => path !== 'grocery');
    expect(arrange(saved, [], withoutGrocery).filter((entry) => !entry.isNew).map((entry) => entry.path)).toEqual(['clothes', 'ice-cream']);
    const back = arrange(saved, [], live);
    expect(back.slice(0, 3).map((entry) => [entry.path, entry.featured])).toEqual([
      ['clothes', false],
      ['grocery', true],
      ['ice-cream', false],
    ]);
  });

  it('features only visible categories', () => {
    const arranged = arrange(config({ featured: ['clothes', 'grocery'] }));
    expect(arranged.filter((entry) => entry.featured).map((entry) => entry.path)).toEqual(['grocery', 'clothes']);
  });

  it('before the first save: the legacy "shown first" list first (featured), then everything else, all shown', () => {
    const arranged = arrange(null, ['ice-cream', 'retired', 'grocery', 'ice-cream']);
    expect(arranged.map((entry) => entry.path)).toEqual(['ice-cream', 'grocery', 'vegetables-fruits', 'electronics', 'clothes']);
    expect(arranged.filter((entry) => entry.featured).map((entry) => entry.path)).toEqual(['ice-cream', 'grocery']);
    expect(arranged.every((entry) => entry.visible && !entry.isNew)).toBe(true);
    // No legacy list either: the catalogue's own order.
    expect(shown(null, [])).toEqual(live);
  });

  it('handles an empty catalogue', () => {
    expect(arrange(config(), [], [])).toEqual([]);
    expect(arrange(null, ['grocery'], [])).toEqual([]);
  });
});

describe('homeMainCategoriesProblem / readHomeMainCategories', () => {
  it('accepts a well-formed arrangement', () => {
    expect(homeMainCategoriesProblem(config({ hidden: ['grocery'], featured: ['clothes'] }))).toBeNull();
    expect(readHomeMainCategories(config())).toEqual(config());
  });

  it('treats the seeded `{}` and anything unreadable as "never saved"', () => {
    expect(readHomeMainCategories({})).toBeNull();
    expect(readHomeMainCategories(null)).toBeNull();
    expect(readHomeMainCategories(['grocery'])).toBeNull();
  });

  it.each([
    ['not an object', ['grocery']],
    ['unknown field', { ...config(), extra: 1 }],
    ['missing newCategoriesVisible', { order: [], hidden: [], featured: [] }],
    ['subcategory path', config({ order: ['grocery/rice'] })],
    ['uppercase path', config({ order: ['Grocery'] })],
    ['duplicate in order', config({ order: ['grocery', 'grocery'] })],
    ['hidden not in order', config({ order: ['grocery'], hidden: ['clothes'] })],
    ['featured not in order', config({ order: ['grocery'], featured: ['clothes'] })],
    ['featured and hidden', config({ hidden: ['grocery'], featured: ['grocery'] })],
    ['too many', config({ order: Array.from({ length: 201 }, (_, i) => `c${i}`) })],
  ])('refuses: %s', (_label, value) => {
    expect(homeMainCategoriesProblem(value)).not.toBeNull();
  });
});

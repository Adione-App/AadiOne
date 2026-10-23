/**
 * resolveHomeLayout (shared/home-layout.ts) — the one place Home layout
 * defaults and limits live. The server stores its output, the Admin Panel
 * preview and the app run it again; it must never throw and must always
 * return a complete, safe layout, whatever it is given.
 */

import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PLACEMENT_KEYS,
  DEFAULT_HOME_LAYOUT,
  HOME_SECTION_KEYS,
  categoryPath,
  categoryPlacementLimit,
  contentColor,
  resolveBannerLayout,
  resolveHomeLayout,
} from '../../src/shared';

const keys = (layout: ReturnType<typeof resolveHomeLayout>) => layout.sections.map((section) => section.key);

describe('resolveHomeLayout', () => {
  it('anything that is not a layout yields the complete defaults', () => {
    for (const raw of [undefined, null, 42, 'layout', [], { hero: 'x', sections: 'y', categoryPlacements: 7 }]) {
      const layout = resolveHomeLayout(raw);
      expect(layout.schema).toBe(1);
      expect(keys(layout)).toEqual([...HOME_SECTION_KEYS]);
      expect(Object.keys(layout.categoryPlacements)).toEqual([...CATEGORY_PLACEMENT_KEYS]);
      expect(layout.hero).toEqual(DEFAULT_HOME_LAYOUT.hero);
      expect(layout.categoryStyles).toEqual([]);
    }
  });

  it('is idempotent: resolving a resolved layout changes nothing', () => {
    const once = resolveHomeLayout({ hero: { cards: { maxItems: 2 } }, sections: [{ key: 'offers', visible: false }] });
    expect(resolveHomeLayout(structuredClone(once))).toEqual(once);
  });

  it('clamps every number to its limits', () => {
    const layout = resolveHomeLayout({
      hero: { cards: { maxItems: 50, height: 5 }, background: { overlayOpacity: 3 } },
      categoryPlacements: { home_top: { maxItems: 0, columns: 99, rows: -2 } },
      sections: [{ key: 'food_carousel', maxItems: 999 }],
    });
    expect(layout.hero.cards).toMatchObject({ maxItems: 4, height: 88 });
    expect(layout.hero.background.overlayOpacity).toBe(0.6);
    expect(layout.categoryPlacements.home_top).toMatchObject({ maxItems: 1, columns: 6, rows: 1 });
    expect(layout.sections.find((section) => section.key === 'food_carousel')?.maxItems).toBe(10);
  });

  it('accepts only named colours or #RRGGBB — never CSS or other text', () => {
    const layout = resolveHomeLayout({
      hero: { background: { color: 'url(javascript:alert(1))', colorTo: '#ffaa00', overlayColor: 'mint' } },
      sections: [{ key: 'offers', background: 'red; position: fixed' }],
    });
    expect(layout.hero.background.color).toBe(DEFAULT_HOME_LAYOUT.hero.background.color);
    expect(layout.hero.background.colorTo).toBe('#ffaa00');
    expect(layout.hero.background.overlayColor).toBe('mint');
    expect(layout.sections.find((section) => section.key === 'offers')?.background).toBe('none');
    expect(contentColor('peach')).toBe('#FFE7D1');
    expect(contentColor('#abcdef')).toBe('#ABCDEF');
    expect(contentColor('rgba(0,0,0,1)', '#FFFFFF')).toBe('#FFFFFF');
  });

  it('an image background without a usable image falls back to the gradient', () => {
    expect(resolveHomeLayout({ hero: { background: { type: 'image', imageUrl: null } } }).hero.background.type).toBe('gradient');
    expect(resolveHomeLayout({ hero: { background: { type: 'image', imageUrl: 'javascript:x' } } }).hero.background.type).toBe('gradient');
    const ok = resolveHomeLayout({ hero: { background: { type: 'image', imageUrl: 'https://cdn.example.com/a.webp' } } });
    expect(ok.hero.background).toMatchObject({ type: 'image', imageUrl: 'https://cdn.example.com/a.webp' });
  });

  it('keeps the admin\'s section order, drops unknown and repeated sections, and appends missing ones in their default place', () => {
    const layout = resolveHomeLayout({
      sections: [
        { key: 'offers', visible: false },
        { key: 'html_widget' },
        { key: 'top_categories', title: 'Shop by category' },
        { key: 'offers', visible: true },
      ],
    });
    // The listed order is kept (offers once — its first entry); each missing
    // section follows the nearest section that precedes it in the default order.
    expect(keys(layout)).toEqual([
      'offers',
      'recently_added', // default: after offers
      'previous_orders',
      'bottom_banner',
      'top_categories',
      'food_carousel', // default: after top_categories
      'featured_shelves',
      'explore_subcategories',
      'more_shelves',
      'more_categories',
      'top_picks',
      'offers_rail',
    ]);
    expect(layout.sections[0]!.visible).toBe(false);
    expect(layout.sections[4]!.title).toBe('Shop by category');
  });

  it('titles only for sections that have one, trimmed, without control characters, length-limited', () => {
    const layout = resolveHomeLayout({
      sections: [
        { key: 'top_picks', title: '  Best\u0000 sellers \n', subtitle: 'x'.repeat(500) },
        { key: 'featured_shelves', title: 'Ignored' },
      ],
    });
    const picks = layout.sections.find((section) => section.key === 'top_picks')!;
    expect(picks.title).toBe('Best  sellers');
    expect(picks.subtitle).toHaveLength(120);
    expect(layout.sections.find((section) => section.key === 'featured_shelves')!.title).toBeNull();
  });

  it('category placements are independent, and keep only valid, unique paths', () => {
    const layout = resolveHomeLayout({
      categoryPlacements: {
        home_top: { mode: 'manual', paths: ['grocery', 'grocery', 'Grocery', '../x', 'snacks/chips', 'a/b/c'], maxItems: 8 },
        categories_page: { maxItems: 16, columns: null },
      },
    });
    expect(layout.categoryPlacements.home_top.paths).toEqual(['grocery', 'snacks/chips']);
    expect(layout.categoryPlacements.home_top.maxItems).toBe(8);
    expect(layout.categoryPlacements.categories_page).toMatchObject({ maxItems: 16, columns: null, mode: 'auto' });
    expect(layout.categoryPlacements.home_explore.maxItems).toBe(10);
  });

  it('category styles: valid paths once each; a style that changes nothing is dropped', () => {
    const layout = resolveHomeLayout({
      categoryStyles: [
        { path: 'grocery', displayName: 'Kirana', hidden: false },
        { path: 'grocery', displayName: 'Second copy' },
        { path: 'snacks', displayName: '   ', hidden: false },
        { path: 'BAD PATH', hidden: true },
        { path: 'grocery/rice', hidden: true, textColor: 'neon' },
      ],
    });
    expect(layout.categoryStyles).toEqual([
      { path: 'grocery', displayName: 'Kirana', displayNameHi: null, tileBackground: null, textColor: null, hidden: false },
      { path: 'grocery/rice', displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: true },
    ]);
  });

  it('rows limit the visible count together with columns', () => {
    const base = resolveHomeLayout(null).categoryPlacements.home_top;
    expect(categoryPlacementLimit(base, 4)).toBe(8);
    expect(categoryPlacementLimit({ ...base, rows: 1 }, 4)).toBe(4);
    expect(categoryPlacementLimit({ ...base, rows: 5 }, 4)).toBe(8);
    expect(categoryPath({ slug: 'rice' }, { slug: 'grocery' })).toBe('grocery/rice');
    expect(categoryPath({ slug: 'grocery' })).toBe('grocery');
  });
});

describe('banner layout presets', () => {
  it('the warm backgrounds and the text tone resolve; anything else falls back', () => {
    expect(resolveBannerLayout({ background: 'peach', textTone: 'light' }, 'tile')).toMatchObject({ variant: 'tile', background: 'peach', textTone: 'light' });
    expect(resolveBannerLayout({ background: '#ff0000' as never, textTone: 'neon' as never })).toMatchObject({ background: 'none', textTone: 'dark' });
    // Existing banners keep exactly what they had.
    expect(resolveBannerLayout({ background: 'green' })).toMatchObject({ background: 'green' });
  });
});

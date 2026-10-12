/**
 * Home feed selection rules (src/modules/catalog/home-selection.ts): admin
 * category order and subcategory-balanced shelves.
 */

import { describe, expect, it } from 'vitest';
import { balanceBySubcategory, orderByPreference, subcategoryOf } from '../../src/modules/catalog/home-selection';

const row = (id: string, path: string) => ({ id, path });

describe('orderByPreference', () => {
  const items = ['grocery', 'men', 'women', 'toys', 'kitchen'];

  it('puts the admin-listed paths first, in that order, then everything else in its own order', () => {
    const { ordered, featured } = orderByPreference(items, (path) => path, ['toys', 'grocery']);
    expect(featured).toEqual(['toys', 'grocery']);
    expect(ordered).toEqual(['toys', 'grocery', 'men', 'women', 'kitchen']);
  });

  it('skips listed paths that no longer exist and repeated entries', () => {
    const { ordered, featured } = orderByPreference(items, (path) => path, ['gone', 'women', 'women']);
    expect(featured).toEqual(['women']);
    expect(ordered).toEqual(['women', 'grocery', 'men', 'toys', 'kitchen']);
  });

  it('keeps the existing order when nothing is listed (or the setting is missing)', () => {
    expect(orderByPreference(items, (path) => path, []).ordered).toEqual(items);
    expect(orderByPreference(items, (path) => path, undefined).featured).toEqual([]);
  });

  it('places a category that is new tomorrow after the listed ones automatically', () => {
    const { ordered } = orderByPreference([...items, 'pet-care'], (path) => path, ['kitchen']);
    expect(ordered).toEqual(['kitchen', 'grocery', 'men', 'women', 'toys', 'pet-care']);
  });
});

describe('subcategoryOf', () => {
  it('maps a product path to its subcategory under the top path', () => {
    expect(subcategoryOf('grocery', 'grocery/rice')).toBe('grocery/rice');
    expect(subcategoryOf('grocery', 'grocery/rice/basmati')).toBe('grocery/rice');
    expect(subcategoryOf('grocery', 'grocery')).toBe('grocery');
    // "grocery-extra" is a different category, not a child of "grocery".
    expect(subcategoryOf('grocery', 'grocery-extra/rice')).toBe('grocery');
  });
});

describe('balanceBySubcategory', () => {
  const candidates = [
    row('r1', 'grocery/rice'),
    row('r2', 'grocery/rice'),
    row('r3', 'grocery/rice'),
    row('r4', 'grocery/rice'),
    row('o1', 'grocery/oil'),
    row('s1', 'grocery/snacks'),
    row('s2', 'grocery/snacks'),
    row('t1', 'grocery'),
  ];

  it('takes one product from every subcategory before a second from any', () => {
    expect(balanceBySubcategory(candidates, 'grocery', 10)).toEqual(['r1', 'o1', 's1', 't1', 'r2', 's2', 'r3', 'r4']);
  });

  it('stops at the limit, keeping the round-robin order', () => {
    expect(balanceBySubcategory(candidates, 'grocery', 5)).toEqual(['r1', 'o1', 's1', 't1', 'r2']);
  });

  it('keeps each subcategory in its own rank order and lets the best-ranked subcategory go first', () => {
    const ranked = [row('s1', 'grocery/snacks'), row('r1', 'grocery/rice'), row('s2', 'grocery/snacks'), row('r2', 'grocery/rice')];
    expect(balanceBySubcategory(ranked, 'grocery', 10)).toEqual(['s1', 'r1', 's2', 'r2']);
  });

  it('never invents products: fewer candidates means a shorter shelf, none means empty', () => {
    expect(balanceBySubcategory([row('x', 'toys')], 'toys', 10)).toEqual(['x']);
    expect(balanceBySubcategory([], 'toys', 10)).toEqual([]);
  });

  it('ignores a product listed twice and is the same on every call', () => {
    const twice = [...candidates, row('r1', 'grocery/rice')];
    expect(balanceBySubcategory(twice, 'grocery', 10)).toEqual(balanceBySubcategory(candidates, 'grocery', 10));
  });
});

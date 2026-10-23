/**
 * Home feed selection rules (src/modules/catalog/home-selection.ts): admin
 * category order, subcategory-balanced shelves, rail de-duplication and the
 * paced (bounded-concurrency) shelf queries.
 */

import { describe, expect, it } from 'vitest';
import {
  balanceBySubcategory,
  mapWithConcurrency,
  orderByPreference,
  pickRailProducts,
  subcategoryOf,
} from '../../src/modules/catalog/home-selection';

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

describe('pickRailProducts', () => {
  it('fills rails in order; each skips what an earlier rail already used', () => {
    const rails = pickRailProducts(
      [
        ['a', 'b', 'c', 'd', 'e', 'f'],
        ['a', 'b', 'g', 'h', 'i', 'j', 'k'],
      ],
      4,
      2,
    );
    expect(rails).toEqual([
      ['a', 'b', 'c', 'd'],
      ['g', 'h', 'i', 'j'],
    ]);
  });

  it('a rail left with fewer than the minimum fresh products shows its own top products, repeats included', () => {
    const rails = pickRailProducts(
      [
        ['a', 'b', 'c'],
        ['a', 'b', 'c', 'd'], // only "d" is fresh: fewer than 2
        ['e', 'd', 'f'],
      ],
      3,
      2,
    );
    expect(rails[1]).toEqual(['a', 'b', 'c']);
    // Everything a rail shows counts as used afterwards — including its repeats.
    expect(rails[2]).toEqual(['e', 'd', 'f']); // "d" was never shown, so it is still fresh
  });

  it('empty candidate lists give empty rails', () => {
    expect(pickRailProducts([[], []], 10, 4)).toEqual([[], []]);
    expect(pickRailProducts([], 10, 4)).toEqual([]);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 5, 20, 1, 15, 2, 8], 3, async (ms, index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return `${index}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:15', '5:2', '6:8']);
    expect(peak).toBe(3);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('a failing item rejects the whole call (no silently missing shelf)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('shelf query failed');
        return n;
      }),
    ).rejects.toThrow('shelf query failed');
  });
});
